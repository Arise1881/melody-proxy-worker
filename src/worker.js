/**
 * Melody Stream Proxy — Cloudflare Workers
 *
 * Türk mobil operatörleri googlevideo.com CDN bağlantısını IP düzeyinde
 * kısıtlayabiliyor. Bu worker, googlevideo akış URL'lerini Cloudflare
 * ağı üzerinden sunar: kullanıcı engelli CDN'e asla doğrudan bağlanmaz.
 *
 * Kullanım:
 *   GET /stream/<base64url(goglevideo_url)>   → akış (Range passthrough)
 *   GET /health                                → sağlık kontrolü
 *
 * Yalnızca googlevideo.com host'larına izin verilir (SSRF koruması).
 */

const TARGET_SUFFIX = 'googlevideo.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function b64UrlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4 !== 0) input += '=';
  return atob(input);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response('', { status: 204 });
    }

    // CORS ön kontrol aydınlatması yok — yalnızca native istemci.
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    const match = url.pathname.match(/^\/stream\/([A-Za-z0-9_-]+)$/);
    if (!match) {
      return new Response('not found', { status: 404 });
    }

    let target;
    try {
      target = b64UrlDecode(match[1]);
    } catch (_) {
      return new Response('bad url', { status: 400 });
    }

    let t;
    try {
      t = new URL(target);
    } catch (_) {
      return new Response('bad url', { status: 400 });
    }

    if (t.protocol !== 'https:' || !t.hostname.endsWith('.' + TARGET_SUFFIX)) {
      return new Response('forbidden', { status: 403 });
    }

    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
    };
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;

    const upstream = await fetch(t.toString(), {
      method: method,
      headers: headers,
      redirect: 'follow',
    });

    const resp = new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
    return resp;
  },
};