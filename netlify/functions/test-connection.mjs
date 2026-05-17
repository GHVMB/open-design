// Implements POST /api/test/connection — smoke-tests a BYOK provider connection.
// Ported from apps/daemon/src/connectionTest.ts for Netlify serverless deployment.
// Agent mode (mode: 'agent') is not supported without the local daemon.

const SMOKE_PROMPT = 'Reply with only: ok';
const MAX_TOKENS = 100;
const TIMEOUT_MS = 12000;

function validateBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl).replace(/\/+$/, ''));
  } catch {
    return { error: 'Invalid baseUrl' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http/https allowed' };
  }
  const h = parsed.hostname.toLowerCase();
  if (
    h === 'localhost' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) ||
    /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  ) {
    return { error: 'Internal IPs blocked', forbidden: true };
  }
  return { parsed };
}

function appendVersionedApiPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const trimmed = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+(\/|$)/.test(trimmed) ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`;
  return url.toString();
}

function buildCall(protocol, baseUrl, apiKey, model, apiVersion) {
  switch (protocol) {
    case 'anthropic':
      return {
        url: appendVersionedApiPath(baseUrl, '/messages'),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: SMOKE_PROMPT }], stream: false },
      };
    case 'openai':
      return {
        url: appendVersionedApiPath(baseUrl, '/chat/completions'),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: SMOKE_PROMPT }], stream: false },
      };
    case 'azure': {
      const url = new URL(baseUrl);
      const basePath = url.pathname.replace(/\/+$/, '');
      const versioned = /\/openai\/v\d+(?:$|\/)/.test(basePath);
      const ver = (typeof apiVersion === 'string' && apiVersion.trim()) ? apiVersion.trim() : (versioned ? '' : '2024-10-21');
      url.pathname = versioned ? `${basePath}/chat/completions` : `${basePath}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
      if (ver) url.searchParams.set('api-version', ver);
      return {
        url: url.toString(),
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: { ...(versioned ? { model } : {}), max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: SMOKE_PROMPT }], stream: false },
      };
    }
    case 'google':
      return {
        url: `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: { contents: [{ role: 'user', parts: [{ text: SMOKE_PROMPT }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } },
      };
    case 'ollama': {
      const clean = baseUrl.replace(/\/+$/, '').replace(/\/api\/?$/, '');
      return {
        url: `${clean}/api/chat`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: { model, messages: [{ role: 'user', content: SMOKE_PROMPT }], stream: false },
      };
    }
    default:
      throw new Error(`Unknown protocol: ${protocol}`);
  }
}

function statusToKind(status) {
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'invalid_base_url';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'unknown';
}

function inspectCompletion(protocol, data) {
  if (protocol === 'openai' || protocol === 'azure') {
    return { valid: Array.isArray(data?.choices) && data.choices.length > 0, sample: 'valid completion' };
  }
  if (protocol === 'anthropic') {
    return { valid: Array.isArray(data?.content) || typeof data?.stop_reason === 'string', sample: 'valid completion' };
  }
  if (protocol === 'google') {
    return { valid: Array.isArray(data?.candidates), sample: 'valid completion' };
  }
  if (protocol === 'ollama') {
    return { valid: Array.isArray(data?.messages) || typeof data?.message?.content === 'string', sample: 'valid completion' };
  }
  return { valid: false };
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const start = Date.now();

  if (body?.mode === 'agent') {
    return json({
      ok: false,
      kind: 'agent_not_installed',
      latencyMs: Date.now() - start,
      model: body?.model ?? 'default',
      detail: 'Agent connection tests require the local Open Design daemon. Run `pnpm tools-dev run web` locally.',
    });
  }

  if (body?.mode !== 'provider') {
    return new Response(JSON.stringify({ error: { message: 'mode must be "provider" or "agent"' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { protocol, baseUrl, apiKey, model, apiVersion } = body;
  if (!['anthropic', 'openai', 'azure', 'google', 'ollama'].includes(protocol)) {
    return new Response(JSON.stringify({ error: { message: 'protocol must be one of anthropic|openai|azure|google|ollama' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
    return new Response(JSON.stringify({ error: { message: 'baseUrl, apiKey, and model are required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const validated = validateBaseUrl(baseUrl);
  if (validated.error) {
    return json({ ok: false, kind: validated.forbidden ? 'forbidden' : 'invalid_base_url', latencyMs: Date.now() - start, model, detail: validated.error });
  }

  let call;
  try { call = buildCall(protocol, baseUrl, apiKey, model, apiVersion); } catch (err) {
    return json({ ok: false, kind: 'unknown', latencyMs: Date.now() - start, model, detail: err.message });
  }

  try {
    const response = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const rawText = await response.text();
    let data = {};
    try { data = rawText ? JSON.parse(rawText) : {}; } catch { /* ignore */ }

    if (!response.ok) {
      const detail = data?.error?.message ?? data?.message ?? rawText.trim().slice(0, 240);
      return json({ ok: false, kind: statusToKind(response.status), latencyMs, model, status: response.status, detail });
    }

    const { valid, sample } = inspectCompletion(protocol, data);
    if (!valid) {
      return json({ ok: false, kind: 'unknown', latencyMs, model, status: response.status, detail: 'Unexpected response shape from provider.' });
    }
    return json({ ok: true, kind: 'success', latencyMs, model, status: response.status, sample });
  } catch (err) {
    return json({ ok: false, kind: err?.name === 'TimeoutError' ? 'timeout' : 'unknown', latencyMs: Date.now() - start, model, detail: err?.message ?? 'Request failed' });
  }
};

export const config = { path: '/api/test/connection' };
