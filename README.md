# Melody Stream Proxy

Cloudflare Workers üzerinde çalışan, googlevideo.com akışlarını proxy'leyen
açık kaynak uygulama. **Türk mobil operatörlerinin googlevideo CDN IP
kısıtlamasını** aşmak için tasarlandı — Melody müzik uygulaması bu worker
üzerinden akar, kullanıcı engelli CDN'e asla doğrudan bağlanmaz.

- Tamamen ücretsiz: Cloudflare Workers ücretsiz planı (günlük 100.000 istek)
- Ömür boyu: hesap kapandıkça çalışır, PC/sunucu gerekmez
- Açık kaynak: GPL-3.0
- Yalnızca `googlevideo.com` host'larına erişim (SSRF korumalı)

## Kurulum (tarayıcıdan, Windows/macOS/Linux/Android çalışır)

1. **Cloudflare hesabı** aç: https://dash.cloudflare.com/sign-up (ücretsiz)
2. Sol menü → **Workers & Pages** → **Create** → **Create Worker**
3. Ad ver: `melody-stream` (istediğiniz) → **Deploy**
4. **Edit code** → `worker.js` içeriğini yapıştır → **Deploy**
5. Worker URL'niz: `https://melody-stream.<kullanici>.workers.dev`

## Kullanım

```
GET /health                          → "ok"
GET /stream/<base64url(googlevideo)> → akış (Range passthrough)
```

### Melody'de kullanım

Melody → Ayarlar → **Akış proxy URL** alanına şunu yaz:

```
https://melody-stream.<kullanici>.workers.dev
```

Uygulama googlevideo URL'lerini otomatik olarak
`<proxy>/stream/<base64>` biçiminde sarar. Derecelendirmede proxy'nin öncesinde
Invidious proxy (darkness) denenir; ikisi de olmazsa googlevideo düz denir.

## CLI ile deploy (opsiyonel)

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

## Lisens

GPL-3.0 — bkz. LICENSE (Melody projesiyle uyumlu).