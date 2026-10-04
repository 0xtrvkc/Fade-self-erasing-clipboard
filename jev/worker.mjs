/* Server-owned questions; never an arbitrary paid API proxy. */
import './contract.js';
import './feature.js';
const C = globalThis.JevContract,
  F = globalThis.JevFeature;
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
async function readJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) fail('JSON input required.');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 60000) {
        await reader.cancel();
        fail('Request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(out));
  } catch {
    fail('Invalid JSON.');
  }
}
async function authorizedToken(request, token) {
  if (typeof token !== 'string' || token.length < 32)
    fail('Configure JEV_ACCESS_TOKEN on the server.', 503);
  const expected = new TextEncoder().encode('Bearer ' + token),
    actual = new TextEncoder().encode(request.headers.get('Authorization') || '');
  const digest = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', x));
  const [a, b] = await Promise.all([digest(expected), digest(actual)]);
  let different = actual.length ^ expected.length;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}
export async function handleJev(request, env, { authenticated = false, fetcher = fetch } = {}) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  try {
    if (!origin || !allowed.includes(origin)) fail('Origin not allowed.', 403);
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') fail('Use POST.', 405);
    if (!authenticated && F.private && !(await authorizedToken(request, env.JEV_ACCESS_TOKEN)))
      fail('Access token required.', 401);
    if (!env.TYPESAFE_API_KEY) fail('Jev is not configured. Existing tools still work.', 503);
    if (!env.JEV_LIMITER?.limit) fail('Configure the Jev rate-limit binding.', 503);
    // A shared feature budget per Cloudflare location limits anonymous aggregate use too.
    if (!(await env.JEV_LIMITER.limit({ key: 'jev:' + F.id })).success)
      fail('Jev request limit reached. Try again in a minute.', 429);
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
      fail('JSON required.', 415);
    const body = await readJSON(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.input)
      fail('Input required.');
    let spec;
    try {
      spec = F.build(body.input);
    } catch (error) {
      fail(error.message);
    }
    let res;
    try {
      res = await fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.TYPESAFE_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env.JEV_MODEL || 'jev-latest',
          state: spec.state,
          questions: spec.questions,
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (error) {
      fail(
        error.name === 'TimeoutError' ? 'Jev timed out. Try again.' : 'Jev service unavailable.',
        error.name === 'TimeoutError' ? 504 : 502,
      );
    }
    if (!res.ok)
      fail(
        res.status === 429 || res.status === 529
          ? 'Jev is busy. Try again later.'
          : 'Jev service unavailable.',
        res.status === 429 || res.status === 529 ? 429 : 502,
      );
    let checked;
    try {
      checked = C.validate(spec.questions, await res.json());
    } catch {
      fail('Jev returned an invalid answer. No changes applied.', 502);
    }
    return reply(checked);
  } catch (error) {
    return reply(
      {
        error: error.status
          ? error.message
          : error.name === 'TimeoutError'
            ? 'Jev timed out. Try again.'
            : 'Unable to evaluate this input. Check configuration or input limits.',
      },
      error.status || 400,
    );
  }
}
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/jev')
      return new Response('Not found', { status: 404 });
    return handleJev(request, env);
  },
};
