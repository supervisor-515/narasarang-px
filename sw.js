/* PX픽 서비스 워커 — 같은 출처 자산은 stale-while-revalidate (캐시 먼저 보여주고 뒤에서 갱신) */
var CACHE = 'pxpick-v2-review3';
var ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'data/cards.json',
  'manifest.webmanifest',
  'icons/sprite.svg',
  'icons/favicon.svg',
  'icons/app-icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 폰트 CDN 등 다른 출처는 브라우저 기본 동작에 맡긴다
  if (url.origin !== self.location.origin) return;

  var isPage = req.mode === 'navigate';
  event.respondWith(caches.open(CACHE).then(function (cache) {
    var key = isPage ? './' : req;
    return cache.match(key, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(network.catch(function () {}));
        return cached;
      }
      return network.catch(function () { return Response.error(); });
    });
  }));
});
