/**
 * Melody Stream Proxy — Cloudflare Workers
 *
 * Türk mobil operatörleri googlevideo.com CDN bağlantısını IP düzeyinde
 * kısıtlayabiliyor. Bu worker iki katmanlı çözüm sunar:
 *
 *   1. /v1/stream/{videoId}            → Invidious'tan ses URL'sini çözer ve
 *                                        googlevideo'dan akıtır (tek adres)
 *   2. /stream/{base64url(goglevideo)} → Hazır URL'yi akıtır (Range passthrough)
 *   3. /health                          → Sağlık kontrolü
 *
 * Kullanıcı engelli CDN'e asla doğrudan bağlanmaz. Yalnızca googlevideo.com
 * host'larına erişim (SSRF korumalı).
 */

const TARGET_SUFFIX = 'googlevideo.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Invidious: worker Cloudflare ağından erişir, kullanıcının operatörü engelliyor olsa da çalışır.
const INVIDIOUS_HOSTS = [
  'invidious.darkness.services',
  'invidious.f5.si',
  'inv.nadeko.net',
  'invidious.private.tube',
  'invidious.privacyredirect.com',
  'yt.artemislena.eu',
  'invidious.reallyaweso.me',
  'invidious.nerdvpn.de',
];

function b64UrlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4 !== 0) input += '=';
  return atob(input);
}

function pickAudioUrls(json) {
  const formats = [
    ...(json.adaptiveFormats || []),
    ...(json.formatStreams || []),
    ...(json.formats || []),
  ];
  if (!formats.length) return [];
  const itag = (f) => {
    const v = f.itag;
    return v == null ? null : String(v).trim();
  };
  const mime = (f) => (f.mimeType || f.type || '').toLowerCase();
  // Öncelikliler: m4a 128, opus 160, m4a 48, sonra tüm audio mime'ları.
  const rank = (f) => {
    const i = itag(f);
    if (i === '140') return 0;
    if (i === '251') return 1;
    if (i === '139') return 2;
    if (i === '250') return 3;
    if (i === '249') return 4;
    if (mime(f).startsWith('audio/')) return 5;
    return 99;
  };
  const urls = [];
  for (const f of formats) {
    if (rank(f) >= 99) continue;
    const u = f.url;
    if (typeof u === 'string' && u.startsWith('https://') && !urls.includes(u)) {
      urls.push({ u, r: rank(f) });
    }
  }
  urls.sort((a, b) => a.r - b.r);
  return urls.map((x) => x.u);
}

async function resolveAudioUrls(videoId) {
  const errors = [];
  for (const host of INVIDIOUS_HOSTS) {
    // local=true: Invidious kendi CDN'i üzerinden proxy'ler. googlevideo
    // URL'leri doğrudan Cloudflare'den çekilince bazı videolarda 403
    // (imza/IP kısıtı) döndüğü için instance proxy'si zorunlu.
    const api =
      `https://${host}/api/v1/videos/${encodeURIComponent(videoId)}?local=true`;
    try {
      const res = await fetch(api, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        redirect: 'follow',
      });
      if (!res.ok) {
        errors.push(`${host}:${res.status}`);
        continue;
      }
      const json = await res.json();
      const urls = pickAudioUrls(json);
      if (urls.length) return urls;
      errors.push(`${host}:no-audio`);
    } catch (e) {
      errors.push(`${host}:err`);
    }
  }
  throw new Error('resolve-failed ' + errors.join(','));
}

function isAllowedTarget(hostname) {
  if (hostname === TARGET_SUFFIX || hostname.endsWith('.' + TARGET_SUFFIX)) {
    return true;
  }
  // local=true URL'leri Invidious host'unda gelir; ona da izin ver.
  return INVIDIOUS_HOSTS.includes(hostname);
}

async function streamUpstream(target, request) {
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'follow',
    });
  } catch (e) {
    return new Response('upstream fetch failed: ' + (e.message || e), {
      status: 502,
    });
  }
  const out = new Headers();
  for (const [k, v] of upstream.headers) out.set(k, v);
  out.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response('', { status: 204 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    // 1) videoId → Invidious çözümle → googlevideo'dan akıt
    const vidMatch = url.pathname.match(/^\/v1\/stream\/([A-Za-z0-9_-]{6,20})$/);
    if (vidMatch) {
      let urls;
      try {
        urls = await resolveAudioUrls(vidMatch[1]);
      } catch (e) {
        return new Response(String(e.message || e), { status: 502 });
      }
      let lastResp = null;
      let lastErr = 'no-candidates';
      for (const audioUrl of urls) {
        let t;
        try {
          t = new URL(audioUrl);
        } catch (_) {
          continue;
        }
        if (!isAllowedTarget(t.hostname)) continue;
        const resp = await streamUpstream(t.toString(), request);
        // 2xx/3xx → başarı; 4xx/5xx → sıradaki formatı dene (bazı CDN
        // düğümleri belirli Cloudflare kolonlarına 403 döner).
        if (resp.status < 400) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          // Anubis/bot-challenge HTML dönerse geçerli akış değildir → atla.
          if (
            ct.includes('audio/') ||
            ct.includes('video/') ||
            ct.includes('octet-stream')
          ) {
            return resp;
          }
          try {
            await resp.body?.cancel();
          } catch (_) {}
          lastErr = 'unexpected-content';
          continue;
        }
        if (lastResp) {
          // önceki yanıt gövdesini boşalt (worker bellek/stream sızıntısı olmasın)
          try {
            await lastResp.body?.cancel();
          } catch (_) {}
        }
        lastResp = resp;
        lastErr = `cdn:${resp.status}`;
      }
      if (lastResp) return lastResp;
      return new Response(lastErr, { status: 502 });
    }

    // 2) Hazır googlevideo URL'sini akıt
    const m = url.pathname.match(/^\/stream\/([A-Za-z0-9_-]+)$/);
    if (m) {
      let target;
      try {
        target = b64UrlDecode(m[1]);
      } catch (_) {
        return new Response('bad url', { status: 400 });
      }
      let t;
      try {
        t = new URL(target);
      } catch (_) {
        return new Response('bad url', { status: 400 });
      }
      if (t.protocol !== 'https:' || !isAllowedTarget(t.hostname)) {
        return new Response('forbidden', { status: 403 });
      }
      return await streamUpstream(t.toString(), request);
    }

    return new Response('not found', { status: 404 });
  },
};