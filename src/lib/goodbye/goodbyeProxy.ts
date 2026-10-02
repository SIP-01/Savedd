/**
 * Homegoing video generation — shared worker logic.
 *
 * Testable-without-a-server pieces of the "Heaven" backend.
 * `worker.ts` is a thin HTTP shell over these functions.
 *
 * Flow:
 *   1. POST /api/heaven/generate (multipart: photos + JSON fields)
 *      → validate, store reference photos in R2, build the fixed-story
 *      prompt, submit reference-to-video to xAI (with storage_options so
 *      the result lands on xAI's public CDN), persist job in KV.
 *   2. GET  /api/heaven/status/:id (client polls every few seconds)
 *      → lazily advances the xAI job: one status call upstream per poll;
 *      when xAI reports "done" the public files-cdn.x.ai URL is stored on
 *      the job and the job flips to done — video bytes stay on xAI.
 *   3. GET  /api/heaven/:id/video   → 302 to the xAI CDN URL (legacy jobs
 *      whose bytes are in R2 are still served directly).
 *   4. GET  /api/heaven/:id/meta    → public share-page metadata from KV.
 *   5. GET  /api/heaven/:id/ref/:n  → reference photos for xAI to fetch.
 *
 * /api/goodbye/* remains as a legacy alias for pre-rename links.
 *
 * Security invariants:
 *   - XAI_API_KEY is read from env only, injected server-side, never
 *     logged and never present in any response body.
 *   - Upstream xAI error bodies are read only through readErrorSnippet,
 *     which strips the prompt and API key before storing a short snippet
 *     in the server-side job record (never sent to clients).
 *   - Photos are stored under the random job id; nothing is addressable
 *     by user-supplied names.
 *   - Video bytes are hosted on xAI's CDN (storage_options.public_url);
 *     the R2 download path is a fallback only, and is capped while
 *     downloading so a hostile or broken upstream cannot exhaust memory.
 */
import {
  HOMEGOING_MODEL,
  HOMEGOING_RESOLUTION,
  buildHomegoingPrompt,
  validateHomegoingInput,
  type HomegoingInput,
  type HomegoingJob,
  type HomegoingMeta,
} from './homegoing';

/** Minimal KV surface with TTL support (Cloudflare KV compatible). */
export interface HomegoingKVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

/** Minimal R2 surface the worker needs (Cloudflare R2 compatible). */
export interface HomegoingR2Like {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<HomegoingR2ObjectLike | null>;
}

export interface HomegoingR2ObjectLike {
  body: ReadableStream<Uint8Array>;
  writeHttpMetadata(headers: Headers): void;
}

export interface HomegoingEnv {
  /** wrangler secret — xAI API key. */
  XAI_API_KEY?: string;
  /** KV binding for job records. */
  HOMEGOING_JOBS?: HomegoingKVLike;
  /** R2 binding for reference photos + finished videos. */
  HOMEGOING_BUCKET?: HomegoingR2Like;
  /** Optional var override, defaults to https://api.x.ai/v1. */
  XAI_API_ENDPOINT?: string;
}

/** True when the feature is fully configured on this deployment. */
export function homegoingConfigured(env: HomegoingEnv): boolean {
  return Boolean(env.XAI_API_KEY?.trim() && env.HOMEGOING_JOBS && env.HOMEGOING_BUCKET);
}

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB each
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // cap download from upstream
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const JOB_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const XAI_TIMEOUT_MS = 30_000;

function endpoint(env: HomegoingEnv): string {
  return (env.XAI_API_ENDPOINT?.trim() || 'https://api.x.ai/v1').replace(/\/$/, '');
}

function isJobId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

/**
 * Parse and validate the multipart generate request.
 * Returns { input, photos, departedCount } or an error string.
 */
export async function parseGenerateRequest(
  request: Request,
): Promise<{ input: HomegoingInput; photos: File[]; departedCount: number } | string> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return 'Request must be multipart/form-data';
  }

  const fieldsRaw = form.get('fields');
  if (typeof fieldsRaw !== 'string') return 'Missing "fields" JSON part';

  let fieldsJson: unknown;
  try {
    fieldsJson = JSON.parse(fieldsRaw);
  } catch {
    return '"fields" must be valid JSON';
  }

  const input = validateHomegoingInput(fieldsJson);
  if (typeof input === 'string') return input;

  const departed = form.getAll('departedPhotos').filter((v): v is File => v instanceof File);
  const family = form.getAll('familyPhotos').filter((v): v is File => v instanceof File);
  const photos = [...departed, ...family];

  if (departed.length < 1) return 'Please add at least one photo of the person who has passed.';
  if (family.length < 1) return 'Please add at least one photo of the family.';
  if (photos.length > MAX_PHOTOS) return `At most ${MAX_PHOTOS} photos in total.`;

  for (const photo of photos) {
    if (!ALLOWED_IMAGE_TYPES.has(photo.type)) return 'Photos must be JPEG, PNG, or WebP.';
    if (photo.size > MAX_PHOTO_BYTES) return 'Each photo must be under 10 MB.';
    if (photo.size === 0) return 'One of the photos is empty.';
  }

  return { input, photos, departedCount: departed.length };
}

/** Extension for a stored reference photo. */
function photoExt(type: string): string {
  return type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
}

/**
 * Submit a generation: store photos, build prompt, call xAI, persist job.
 * Returns the created job (check job.status — submission failures are
 * reported on the job rather than thrown).
 */
export async function startGeneration(
  env: HomegoingEnv,
  input: HomegoingInput,
  photos: File[],
  departedCount: number,
  origin: string,
): Promise<HomegoingJob> {
  const id = crypto.randomUUID();
  const bucket = env.HOMEGOING_BUCKET!;

  // Store reference photos; xAI fetches them back from our public URLs.
  const referenceUrls: string[] = [];
  for (let i = 0; i < photos.length; i++) {
    const key = `homegoing/${id}/ref-${i}.${photoExt(photos[i].type)}`;
    await bucket.put(key, await photos[i].arrayBuffer(), {
      httpMetadata: { contentType: photos[i].type },
    });
    referenceUrls.push(`${origin}/api/heaven/${id}/ref/${i}`);
  }

  const prompt = buildHomegoingPrompt(input, departedCount, photos.length - departedCount);

  const meta: HomegoingMeta = {
    id,
    departedName: input.departedName,
    departedRelationship: input.departedRelationship,
    aspectRatio: input.aspectRatio,
    duration: input.duration,
    createdAt: Date.now(),
  };

  const job: HomegoingJob = {
    id,
    status: 'pending',
    meta,
    prompt,
    createdAt: Date.now(),
  };

  const submitted = await fetch(`${endpoint(env)}/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.XAI_API_KEY!.trim()}`,
    },
    body: JSON.stringify({
      model: HOMEGOING_MODEL,
      prompt,
      // xAI expects ImageUrl structs, not bare strings (422 otherwise).
      reference_images: referenceUrls.map((url) => ({ url })),
      duration: input.duration,
      aspect_ratio: input.aspectRatio,
      resolution: HOMEGOING_RESOLUTION,
      // Persist the finished MP4 on xAI's own storage with a public CDN
      // link. The video bytes then live on files-cdn.x.ai — Savedd only
      // keeps the URL, so the worker never shuttles multi-MB videos
      // through R2 (the old path doubled our bandwidth per view).
      storage_options: {
        filename: `heaven-${id}.mp4`,
        public_url: true,
      },
    }),
    signal: AbortSignal.timeout(XAI_TIMEOUT_MS),
  }).catch(() => null);

  if (!submitted) {
    job.status = 'failed';
    job.error = 'The video service is unreachable right now — please try again shortly.';
  } else if (!submitted.ok) {
    // Read a small redacted snippet of the upstream error for diagnosis.
    // The prompt and API key are stripped before anything is stored, and
    // the snippet never leaves the server-side job record verbatim unless
    // an operator reads it from KV — public clients only get the friendly
    // message below plus the upstream status code.
    const upstreamStatus = submitted.status;
    job.debug = await readErrorSnippet(submitted, prompt, env.XAI_API_KEY ?? '');
    job.status = 'failed';
    const friendly =
      upstreamStatus === 429
        ? 'The video service is busy — please try again in a minute.'
        : upstreamStatus === 402
          ? 'Video generation is temporarily unavailable.'
          : 'The video service rejected the request. Try simpler wording in the description.';
    job.error = `${friendly} (upstream ${upstreamStatus})`;
  } else {
    const data = (await submitted.json()) as { request_id?: string };
    if (typeof data.request_id === 'string' && data.request_id) {
      job.requestId = data.request_id;
      job.status = 'processing';
    } else {
      job.status = 'failed';
      job.error = 'The video service returned an unexpected response.';
    }
  }

  await env.HOMEGOING_JOBS!.put(`job:${id}`, JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
  return job;
}

export async function readJob(env: HomegoingEnv, id: string): Promise<HomegoingJob | null> {
  if (!isJobId(id)) return null;
  const raw = await env.HOMEGOING_JOBS!.get(`job:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HomegoingJob;
  } catch {
    return null;
  }
}

async function writeJob(env: HomegoingEnv, job: HomegoingJob): Promise<void> {
  await env.HOMEGOING_JOBS!.put(`job:${job.id}`, JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
}

/**
 * Advance a processing job by polling xAI once. When the upstream video is
 * ready, its permanent files-cdn.x.ai URL (from storage_options.public_url)
 * is stored on the job and the job flips to done — the bytes stay on xAI.
 * Falls back to downloading into R2 when no public URL was produced.
 */
export async function advanceJob(env: HomegoingEnv, job: HomegoingJob): Promise<HomegoingJob> {
  if (job.status !== 'processing' || !job.requestId) return job;

  const res = await fetch(`${endpoint(env)}/videos/${job.requestId}`, {
    headers: { Authorization: `Bearer ${env.XAI_API_KEY!.trim()}` },
    signal: AbortSignal.timeout(XAI_TIMEOUT_MS),
  }).catch(() => null);

  if (!res) return job; // transient — try again on the next poll

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    job.status = 'failed';
    job.error = 'The video service reported a problem while generating.';
    await writeJob(env, job);
    return job;
  }

  const data = (await res.json()) as {
    status?: string;
    video?: {
      url?: string;
      file_output?: { public_url?: string; file_id?: string; public_url_error?: string };
    };
  };

  if (data.status === 'failed' || data.status === 'expired') {
    job.status = 'failed';
    job.error = 'This generation did not complete — please create another version.';
    await writeJob(env, job);
    return job;
  }

  if (data.status !== 'done' || !data.video?.url) return job; // still pending

  // Preferred path: the job was submitted with storage_options.public_url,
  // so xAI hands us a stable, unauthenticated files-cdn.x.ai URL nested in
  // video.file_output. Store the URL only — the bytes never touch Savedd
  // (no R2 put, no egress through the worker on every view). The default
  // vidgen.x.ai URL is ephemeral, so only trust files-cdn links as permanent.
  const cdnUrl = data.video.file_output?.public_url;
  if (typeof cdnUrl === 'string' && cdnUrl.startsWith('https://files-cdn.x.ai/')) {
    job.status = 'done';
    job.externalUrl = cdnUrl;
    if (data.video.file_output?.file_id) job.externalFileId = data.video.file_output.file_id;
    await writeJob(env, job);
    return job;
  }

  // Fallback (xAI returned only an ephemeral URL): download immediately
  // into R2 before it expires.
  const video = await fetch(data.video.url, { signal: AbortSignal.timeout(120_000) }).catch(
    () => null,
  );
  if (!video || !video.ok || !video.body) {
    await video?.body?.cancel().catch(() => undefined);
    return job; // retry on next poll while the URL is still fresh
  }

  const bytes = await readCapped(video.body, MAX_VIDEO_BYTES);
  if (!bytes) {
    job.status = 'failed';
    job.error = 'The generated video could not be saved — please create another version.';
    await writeJob(env, job);
    return job;
  }

  await env.HOMEGOING_BUCKET!.put(`homegoing/${job.id}/video.mp4`, bytes, {
    httpMetadata: { contentType: 'video/mp4' },
  });

  job.status = 'done';
  job.videoPath = `/api/heaven/${job.id}/video`;
  await writeJob(env, job);
  return job;
}

/**
 * Read at most `max` chars of an upstream error body with the prompt and
 * API key redacted, so operators can see *why* xAI rejected a submission
 * without secrets or user text ever landing in logs/KV.
 */
async function readErrorSnippet(res: Response, prompt: string, apiKey: string, max = 300): Promise<string> {
  try {
    let text = await res.text();
    if (prompt) text = text.split(prompt).join('[prompt]');
    const key = apiKey.trim();
    if (key) text = text.split(key).join('[key]');
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
  } catch {
    return '';
  }
}

/** Read a stream into memory with a hard cap; null when exceeded. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Serve a stored object (reference photo or finished video) from R2. */
export async function serveStored(
  env: HomegoingEnv,
  id: string,
  key: string,
): Promise<Response | null> {
  if (!isJobId(id)) return null;
  if (!/^[a-z0-9.-]+$/i.test(key)) return null;
  const object = await env.HOMEGOING_BUCKET!.get(`homegoing/${id}/${key}`);
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set(
    'Cache-Control',
    key === 'video.mp4' ? 'public, max-age=31536000, immutable' : 'private, no-store',
  );
  return new Response(object.body, { headers });
}

/** Public metadata for the share page (no prompt, no internals). */
export function publicMeta(job: HomegoingJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    departedName: job.meta.departedName,
    departedRelationship: job.meta.departedRelationship,
    aspectRatio: job.meta.aspectRatio,
    duration: job.meta.duration,
    createdAt: job.meta.createdAt,
    videoUrl: job.status === 'done' ? (job.externalUrl ?? job.videoPath) : undefined,
    error: job.status === 'failed' && job.error ? { message: job.error } : undefined,
  };
}
