// Preload (node --import) that logs every CLI fetch to $BENCH_METER_FILE as JSON lines: host, path, status, timing,
// body sizes and the `usage` of JSON responses. Never headers (API keys), query strings or bodies.
import { appendFileSync } from 'node:fs';

const file = process.env.BENCH_METER_FILE;
const realFetch = globalThis.fetch;

function bodySize(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let n = 0;
    for (const [, v] of body) n += typeof v === 'string' ? Buffer.byteLength(v) : v.size ?? 0;
    return n;
  }
  return -1; // stream or unknown
}

/** Message characters of an OpenAI-style chat request, for a token estimate when usage is missing. */
function promptChars(body) {
  if (typeof body !== 'string') return undefined;
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j.messages)) return undefined;
    return j.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0)
      + (j.response_format ? JSON.stringify(j.response_format).length : 0);
  } catch { return undefined; }
}

if (file && realFetch) {
  globalThis.fetch = async function meteredFetch(input, init) {
    const t0 = Date.now();
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = init?.method ?? req?.method ?? 'GET';
    const body = init?.body;
    const rec = { t: new Date(t0).toISOString(), method, host: url.host, path: url.pathname, reqBytes: bodySize(body), promptChars: promptChars(body) };
    try {
      const res = await realFetch(input, init);
      rec.status = res.status;
      rec.headersMs = Date.now() - t0;
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('json')) {
        res.clone().text().then((text) => {
          rec.ms = Date.now() - t0;
          rec.resChars = text.length;
          try {
            const j = JSON.parse(text);
            if (j.usage) rec.usage = j.usage;
            if (j.model) rec.model = j.model;
            if (typeof j.durationMilliseconds === 'number') rec.audioMs = j.durationMilliseconds; // Azure Speech
            const content = j.choices?.[0]?.message?.content;
            if (typeof content === 'string') rec.completionChars = content.length;
          } catch { /* not JSON after all */ }
          appendFileSync(file, JSON.stringify(rec) + '\n');
        }).catch(() => appendFileSync(file, JSON.stringify(rec) + '\n'));
      } else {
        rec.ms = Date.now() - t0;
        appendFileSync(file, JSON.stringify(rec) + '\n');
      }
      return res;
    } catch (err) {
      rec.error = String(err?.message ?? err).slice(0, 200);
      rec.ms = Date.now() - t0;
      appendFileSync(file, JSON.stringify(rec) + '\n');
      throw err;
    }
  };
}
