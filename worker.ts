/**
 * SAVEDD / community-engine proxy — Cloudflare Worker.
 *
 * Serves the static app AND injects operator secrets server-side:
 *   GET  /api/ai/status            → public config status (masked, no secrets)
 *   POST /api/ai/chat/completions  → OpenAI-compatible proxy, key injected here
 *   GET  /api/ai/models            → provider model list (admin UI helper)
 *   POST /api/ai/admin             → NIP-98-signed config writes (owner key only, KV)
 *   GET  /api/search/brave/status  → whether engine Brave is configured
 *   POST /api/search/brave         → Brave Search proxy, key injected here
 *   …
 *   "Heaven" memorial videos:
 *   POST /api/heaven/generate      → submit photos + fields, start Grok Imagine job
 *   GET  /api/heaven/status/:id    → poll/advance job; videoUrl is an xAI CDN link
 *   GET  /api/heaven/:id/video     → 302 to xAI CDN (or R2 copy for legacy jobs)
 *   GET  /heaven/:id               → share page with OG/Twitter video tags
 *   (/api/goodbye/* kept as legacy aliases)
 *
 * Operator configuration (nothing secret in the repo):
 *   wrangler secret put OPENAI_API_KEY        ← OpenAI (or compatible) key
 *     (legacy alias: AI_API_KEY is also accepted)
 *   wrangler secret put BRAVE_API_KEY         ← Brave Search subscription token
 *   wrangler secret put XAI_API_KEY           ← xAI (Grok Imagine) key
 *   AI_PROVIDER_ENDPOINT / AI_MODEL / AI_PROVIDER_NAME / AI_ENGINE_ENABLED (vars)
 *   OWNER_PUBKEY (var, hex)                   ← enables the Admin → AI tab
 *   AI_CONFIG_KV (KV binding, optional)       ← enables admin-UI-managed config
 *   HOMEGOING_JOBS (KV) + HOMEGOING_BUCKET (R2) ← Heaven video jobs/photos
 *
 * KV config wins over env vars. Neither present → status reports
 * "not configured" and chat returns 503 — fresh clones stay fully
 * functional with AI simply unavailable until a user adds their own key.
 *
 * No logging of request bodies, keys, or provider error payloads anywhere.
 */
import {
  readEngineConfig,
  writeEngineConfig,
  buildPublicStatus,
  validateChatPayload,
  buildUpstreamBody,
  sanitizeProviderError,
  verifyAdminAuth,
  parseAdminAction,
  applyAdminAction,
  type EngineAIEnv,
} from './src/lib/ai/engineProxy';
import {
  braveConfigured,
  validateBravePayload,
  buildBraveSearchUrl,
  type BraveProxyEnv,
} from './src/lib/providers/braveProxy';
import {
  homegoingConfigured,
  parseGenerateRequest,
  startGeneration,
  readJob,
  advanceJob,
  serveStored,
  publicMeta,
  type HomegoingEnv,
} from './src/lib/goodbye/goodbyeProxy';

interface Env extends EngineAIEnv, BraveProxyEnv, HomegoingEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

/**
 * Origins allowed to call the API cross-origin (CORS). The worker reflects
 * the request Origin only when it is allowlisted — never `*` — and API
 * responses carry no cookies, so cross-origin calls are bearer-less by
 * design. The engine keys stay server-side regardless; CORS here only
 * governs which sites may embed the public API, not access to secrets.
 */
const ALLOWED_ORIGINS = new Set([
  'https://savedd.com',
  'https://www.savedd.com',
  'http://localhost:8080',
  'http://localhost:5173',
  'http://127.0.0.1:8080',
]);

function corsOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null; // same-origin / non-browser request — no CORS needed
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function json(data: unknown, status = 200, request?: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Never cache a response derived from server-side config.
    'Cache-Control': 'no-store',
  };
  const origin = request ? corsOrigin(request) : null;
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

/** Answer CORS preflights for the API routes (allowlisted origins only). */
function handleOptions(request: Request): Response {
  const origin = corsOrigin(request);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

/** Best-effort per-IP rate limit (in-memory per isolate — good enough for abuse blunting). */
const hits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_MINUTE = 20;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count++;
  if (hits.size > 10_000) hits.clear(); // bound memory under flood
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

/** Forward a validated chat request to the configured provider. */
async function proxyChat(request: Request, env: Env): Promise<Response> {
  const config = await readEngineConfig(env);
  if (!config || !config.enabled) {
    return json({ error: { message: 'Engine AI is not configured on this deployment', type: 'unavailable' } }, 503, request);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
  if (rateLimited(ip)) {
    return json({ error: { message: 'Rate limit exceeded — slow down', type: 'rate_limited' } }, 429, request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Body must be JSON', type: 'invalid_request' } }, 400, request);
  }

  const payload = validateChatPayload(body);
  if (typeof payload === 'string') {
    return json({ error: { message: payload, type: 'invalid_request' } }, 400, request);
  }

  const upstream = await fetch(`${config.endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`, // server-side only, never logged
    },
    body: JSON.stringify(buildUpstreamBody(payload, config)),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);

  if (!upstream) {
    return json({ error: { message: 'AI provider unreachable', type: 'upstream_unavailable' } }, 502, request);
  }

  if (!upstream.ok) {
    // Drain without reading into memory/logging — upstream bodies can echo
    // request details; clients get a sanitized message only.
    await upstream.body?.cancel().catch(() => undefined);
    return json(
      { error: { message: sanitizeProviderError(upstream.status), type: 'provider_error' } },
      upstream.status === 429 ? 429 : 502,
      request,
    );
  }

  const data = await upstream.json();
  return json(data, 200, request);
}

/** Proxied model list for the admin "Load models" helper. */
async function proxyModels(env: Env): Promise<Response> {
  const config = await readEngineConfig(env);
  if (!config) {
    return json({ error: { message: 'Engine AI is not configured', type: 'unavailable' } }, 503);
  }

  const upstream = await fetch(`${config.endpoint.replace(/\/$/, '')}/models`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!upstream || !upstream.ok) {
    await upstream?.body?.cancel().catch(() => undefined);
    return json({ error: { message: 'Could not load models from the provider', type: 'provider_error' } }, 502);
  }

  return json(await upstream.json());
}

/** Owner-authenticated config write (NIP-98-style signed event, KV-backed). */
async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const auth = await verifyAdminAuth(request.headers.get('Authorization'), request.url, env);
  if (!auth.ok) return json({ error: { message: auth.error, type: 'unauthorized' } }, auth.error === 'Admin is not configured on this deployment' ? 501 : 403);

  if (!env.AI_CONFIG_KV) {
    return json({
      error: {
        message: 'Runtime config storage (KV) is not bound — configure engine AI via environment variables instead',
        type: 'storage_unavailable',
      },
    }, 501);
  }

  let eventContent: string;
  try {
    const header = request.headers.get('Authorization')!;
    const event = JSON.parse(atob(header.slice(6))) as { content?: string };
    eventContent = typeof event.content === 'string' ? event.content : '';
  } catch {
    return json({ error: { message: 'Malformed authorization event', type: 'invalid_request' } }, 400);
  }

  const action = parseAdminAction(eventContent);
  if (typeof action === 'string') {
    return json({ error: { message: action, type: 'invalid_request' } }, 400);
  }

  const current = await readEngineConfig(env);
  const next = applyAdminAction(current, action);
  if (typeof next === 'string') {
    return json({ error: { message: next, type: 'invalid_request' } }, 400);
  }

  await writeEngineConfig(env.AI_CONFIG_KV, next);
  return json({ ok: true, status: buildPublicStatus(next) });
}

/** Forward a validated Brave Search request. The subscription token is injected here. */
async function proxyBrave(request: Request, env: Env): Promise<Response> {
  if (!braveConfigured(env)) {
    return json({ error: { message: 'Brave Search is not configured on this deployment', type: 'unavailable' } }, 503, request);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
  if (rateLimited(ip)) {
    return json({ error: { message: 'Rate limit exceeded — slow down', type: 'rate_limited' } }, 429, request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Body must be JSON', type: 'invalid_request' } }, 400, request);
  }

  const payload = validateBravePayload(body);
  if (typeof payload === 'string') {
    return json({ error: { message: payload, type: 'invalid_request' } }, 400, request);
  }

  const upstream = await fetch(buildBraveSearchUrl(payload), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': env.BRAVE_API_KEY!.trim(),
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!upstream) {
    return json({ error: { message: 'Brave Search unreachable', type: 'upstream_unavailable' } }, 502, request);
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    return json({ error: { message: 'Brave Search rejected the request', type: 'provider_error' } }, upstream.status === 429 ? 429 : 502, request);
  }

  return json(await upstream.json(), 200, request);
}

/**
 * "Heaven" — memorial video generation (grok-imagine-video-1.5
 * reference-to-video). Photos arrive as multipart uploads, are stored in R2
 * under a random job id, and are handed to xAI as reference URLs. The xAI
 * key is injected here; browsers only ever see our own job ids and URLs.
 */
async function handleGoodbyeGenerate(request: Request, env: Env): Promise<Response> {
  if (!homegoingConfigured(env)) {
    return json({ error: { message: 'Video generation is not configured on this deployment', type: 'unavailable' } }, 503, request);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
  if (rateLimited(ip)) {
    return json({ error: { message: 'Rate limit exceeded — slow down', type: 'rate_limited' } }, 429, request);
  }

  const parsed = await parseGenerateRequest(request);
  if (typeof parsed === 'string') {
    return json({ error: { message: parsed, type: 'invalid_request' } }, 400, request);
  }

  const origin = new URL(request.url).origin;
  try {
    const job = await startGeneration(env, parsed.input, parsed.photos, parsed.departedCount, origin);
    // Always 202: a 5xx here gets replaced by the Vercel/edge proxy's own
    // HTML error page, breaking the client's JSON parsing. Failure state is
    // carried in the body's status/error fields instead.
    return json(publicMeta(job), 202, request);
  } catch {
    return json({ error: { message: 'Could not start the generation', type: 'internal' } }, 500, request);
  }
}

/** Client poll endpoint — lazily advances the upstream xAI job. */
async function handleGoodbyeStatus(request: Request, env: Env, id: string): Promise<Response> {
  if (!homegoingConfigured(env)) {
    return json({ error: { message: 'Video generation is not configured on this deployment', type: 'unavailable' } }, 503, request);
  }
  const job = await readJob(env, id);
  if (!job) return json({ error: { message: 'Not found', type: 'not_found' } }, 404, request);
  const advanced = await advanceJob(env, job).catch(() => job);
  return json(publicMeta(advanced), 200, request);
}

async function handleGoodbyeMeta(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.HOMEGOING_JOBS) {
    return json({ error: { message: 'Not configured', type: 'unavailable' } }, 503, request);
  }
  const job = await readJob(env, id);
  if (!job) return json({ error: { message: 'Not found', type: 'not_found' } }, 404, request);
  return json(publicMeta(job), 200, request);
}

/**
 * Serve a finished video. New jobs store only the xAI files-cdn URL — the
 * bytes live on xAI's CDN, so we redirect there instead of proxying the MP4
 * through the worker (that redirect is what keeps video traffic off our
 * edge). Legacy jobs whose bytes are in R2 are still served directly.
 */
async function handleGoodbyeVideo(env: Env, id: string): Promise<Response> {
  if (!env.HOMEGOING_JOBS) return new Response('Not found', { status: 404 });
  const job = await readJob(env, id).catch(() => null);
  if (job?.externalUrl) {
    return new Response(null, {
      status: 302,
      headers: { Location: job.externalUrl, 'Cache-Control': 'public, max-age=300' },
    });
  }
  if (!env.HOMEGOING_BUCKET) return new Response('Not found', { status: 404 });
  const res = await serveStored(env, id, 'video.mp4').catch(() => null);
  return res ?? new Response('Not found', { status: 404 });
}

/** Serve stored reference photos from R2. */
async function handleGoodbyeMedia(env: Env, id: string, key: string): Promise<Response> {
  if (!env.HOMEGOING_BUCKET) return new Response('Not found', { status: 404 });
  const res = await serveStored(env, id, key).catch(() => null);
  return res ?? new Response('Not found', { status: 404 });
}

/** Escape text for safe interpolation into HTML meta attributes. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Share-page HTML with Open Graph/Twitter video tags injected, so links to
 * /heaven/:id unfurl with the video on social platforms. Crawlers get
 * meta tags; browsers get the same SPA as before.
 */
async function serveGoodbyeSharePage(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.ASSETS) return new Response('Not found', { status: 404 });

  const assetResponse = await env.ASSETS.fetch(new Request(new URL('/', request.url).toString(), request));
  if (!assetResponse.ok) return assetResponse;

  let title = 'Heaven — Savedd.com';
  let description = 'An imagined farewell. A picture of hope.';

  if (env.HOMEGOING_JOBS) {
    const job = await readJob(env, id).catch(() => null);
    if (job) {
      const who = job.meta.departedName || 'a loved one';
      title = `Heaven — for ${who} — Savedd.com`;
      description = `An imagined tribute: ${who} says goodbye and walks with Jesus toward heaven. An imagined farewell, created on Savedd.com.`;
    }
  }

  const pageUrl = `https://savedd.com/heaven/${id}`;
  const videoUrl = `https://savedd.com/api/heaven/${id}/video`;
  const tags = [
    `<meta property="og:type" content="video.other" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${pageUrl}" />`,
    `<meta property="og:video" content="${videoUrl}" />`,
    `<meta property="og:video:type" content="video/mp4" />`,
    `<meta name="twitter:card" content="player" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
    `<meta name="twitter:player" content="${pageUrl}" />`,
  ].join('');

  const rewritten = new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(assetResponse);

  const headers = new Headers(rewritten.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(rewritten.body, { status: rewritten.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
        return handleOptions(request);
      }
      if (url.pathname === '/api/ai/status' && request.method === 'GET') {
        return json(buildPublicStatus(await readEngineConfig(env)), 200, request);
      }
      if (url.pathname === '/api/ai/models' && request.method === 'GET') {
        return proxyModels(env);
      }
      if (url.pathname === '/api/ai/chat/completions' && request.method === 'POST') {
        return proxyChat(request, env);
      }
      if (url.pathname === '/api/ai/admin' && request.method === 'POST') {
        return handleAdmin(request, env);
      }
      if (url.pathname === '/api/search/brave/status' && request.method === 'GET') {
        return json({ configured: braveConfigured(env) }, 200, request);
      }
      if (url.pathname === '/api/search/brave' && request.method === 'POST') {
        return proxyBrave(request, env);
      }

      // "Heaven" (formerly "A Peaceful Goodbye") — memorial video generation.
      // /api/heaven/* is canonical; /api/goodbye/* stays so links and jobs
      // created before the rename keep working.
      const heavenApi = url.pathname.match(/^\/api\/(heaven|goodbye)(\/.*)?$/);
      if (heavenApi) {
        const sub = heavenApi[2] ?? '';
        if (sub === '/status' && request.method === 'GET') {
          return json({ configured: homegoingConfigured(env) }, 200, request);
        }
        if (sub === '/generate' && request.method === 'POST') {
          return handleGoodbyeGenerate(request, env);
        }
        const statusMatch = sub.match(/^\/status\/([0-9a-f-]{36})$/i);
        if (statusMatch && request.method === 'GET') {
          return handleGoodbyeStatus(request, env, statusMatch[1]);
        }
        const mediaMatch = sub.match(/^\/([0-9a-f-]{36})\/(video|meta|ref\/\d+)$/i);
        if (mediaMatch && request.method === 'GET') {
          if (mediaMatch[2] === 'meta') return handleGoodbyeMeta(request, env, mediaMatch[1]);
          if (mediaMatch[2] === 'video') return handleGoodbyeVideo(env, mediaMatch[1]);
          // /:id/ref/:n — resolve the stored extension
          const n = mediaMatch[2].split('/')[1];
          for (const ext of ['jpg', 'png', 'webp']) {
            const res = await serveStored(env, mediaMatch[1], `ref-${n}.${ext}`).catch(() => null);
            if (res) return res;
          }
          return new Response('Not found', { status: 404 });
        }
      }

      // Share page: same SPA, but with OG/Twitter video tags injected for crawlers.
      // /goodbye/:id redirects to the canonical /heaven/:id.
      const legacyShare = url.pathname.match(/^\/goodbye\/([0-9a-f-]{36})$/i);
      if (legacyShare && request.method === 'GET') {
        return new Response(null, {
          status: 301,
          headers: { Location: `/heaven/${legacyShare[1]}` },
        });
      }
      const heavenShare = url.pathname.match(/^\/heaven\/([0-9a-f-]{36})$/i);
      if (heavenShare && request.method === 'GET') {
        return serveGoodbyeSharePage(request, env, heavenShare[1]);
      }

      // Everything else → static assets.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch {
      // Deliberately opaque: internal errors must not leak config details.
      return json({ error: { message: 'Internal error', type: 'internal' } }, 500, request);
    }
  },
};
