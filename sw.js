/* 追星消费记账本 · Service Worker（cache-first + 版本化更新） */
const CACHE_VERSION = 'v19';
const CACHE_NAME = 'star-expense-' + CACHE_VERSION;
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isNav = e.request.mode === 'navigate' ||
    (e.request.destination === 'document') ||
    url.pathname.endsWith('.html') || url.pathname === '/' ||
    url.pathname.endsWith('/');

  // 页面导航：网络优先，保证新版立即生效；断网时回退缓存
  if (isNav) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
        }
        return res;
      }).catch(() => caches.match('./index.html').then((c) => c || Response.error()))
    );
    return;
  }

  // 静态资源：缓存优先（资源随版本号一起换新缓存）
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || Response.error());
    })
  );
});
