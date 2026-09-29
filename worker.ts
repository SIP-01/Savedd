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
 *
 * Operator configuration (nothing secret in the repo):
 *   wrangler secret put OPENAI_API_KEY        ← OpenAI (or compatible) key
 *     (legacy alias: AI_API_KEY is also accepted)
 *   wrangler secret put BRAVE_API_KEY         ← Brave Search subscription token
 *   AI_PROVIDER_ENDPOINT / AI_MODEL / AI_PROVIDER_NAME / AI_ENGINE_ENABLED (vars)
 *   OWNER_PUBKEY (var, hex)                   ← enables the Admin → AI tab
 *   AI_CONFIG_KV (KV binding, optional)       ← enables admin-UI-managed config
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
 * "A Peaceful Goodbye" — memorial video generation (grok-imagine-video-1.5
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

/** Serve stored media: the finished video (public) and reference photos. */
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
 * /goodbye/:id unfurl with the video on social platforms. Crawlers get
 * meta tags; browsers get the same SPA as before.
 */
async function serveGoodbyeSharePage(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.ASSETS) return new Response('Not found', { status: 404 });

  const assetResponse = await env.ASSETS.fetch(new Request(new URL('/', request.url).toString(), request));
  if (!assetResponse.ok) return assetResponse;

  let title = 'A Peaceful Goodbye — Savedd.com';
  let description = 'An imagined farewell. A picture of hope.';

  if (env.HOMEGOING_JOBS) {
    const job = await readJob(env, id).catch(() => null);
    if (job) {
      const who = job.meta.departedName || 'a loved one';
      title = `A Peaceful Goodbye — for ${who} — Savedd.com`;
      description = `An imagined tribute: ${who} says goodbye and walks with Jesus toward heaven. An imagined farewell, created on Savedd.com.`;
    }
  }

  const pageUrl = `https://savedd.com/goodbye/${id}`;
  const videoUrl = `https://savedd.com/api/goodbye/${id}/video`;
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

      // "A Peaceful Goodbye" — memorial video generation.
      if (url.pathname === '/api/goodbye/status' && request.method === 'GET') {
        return json({ configured: homegoingConfigured(env) }, 200, request);
      }
      if (url.pathname === '/api/goodbye/generate' && request.method === 'POST') {
        return handleGoodbyeGenerate(request, env);
      }
      const goodbyeStatus = url.pathname.match(/^\/api\/goodbye\/status\/([0-9a-f-]{36})$/i);
      if (goodbyeStatus && request.method === 'GET') {
        return handleGoodbyeStatus(request, env, goodbyeStatus[1]);
      }
      const goodbyeMedia = url.pathname.match(/^\/api\/goodbye\/([0-9a-f-]{36})\/(video|meta|ref\/\d+)$/i);
      if (goodbyeMedia && request.method === 'GET') {
        if (goodbyeMedia[2] === 'meta') return handleGoodbyeMeta(request, env, goodbyeMedia[1]);
        const key = goodbyeMedia[2] === 'video' ? 'video.mp4' : null;
        if (key) return handleGoodbyeMedia(env, goodbyeMedia[1], key);
        // /api/goodbye/:id/ref/:n — resolve the stored extension
        const n = goodbyeMedia[2].split('/')[1];
        for (const ext of ['jpg', 'png', 'webp']) {
          const res = await serveStored(env, goodbyeMedia[1], `ref-${n}.${ext}`).catch(() => null);
          if (res) return res;
        }
        return new Response('Not found', { status: 404 });
      }

      // Share page: same SPA, but with OG/Twitter video tags injected for crawlers.
      const goodbyeShare = url.pathname.match(/^\/goodbye\/([0-9a-f-]{36})$/i);
      if (goodbyeShare && request.method === 'GET') {
        return serveGoodbyeSharePage(request, env, goodbyeShare[1]);
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
