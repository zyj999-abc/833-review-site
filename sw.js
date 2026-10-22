/* 833 复习站 Service Worker
 * 策略：
 *  - 应用外壳与数据 JSON：预缓存 + cache-first + 后台刷新（stale-while-revalidate）
 *  - 教材页图片（data/pages/*.jpg，共 ~51MB 不做全量预缓存）：network-first，访问过即入缓存，离线兜底
 *  - 离线导航回退 index.html
 */
const CACHE = '833review-v4';   // v4：T1（星标/笔记/retention 修复/fuzz/自动存档/备份提醒）
const CORE = [
  './', './index.html', './style.css', './app.js', './manifest.json', './icon.svg',
  './data/meta.json', './data/questions.json', './data/mindmaps.json', './data/pages.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isPageImg = url.pathname.includes('/data/pages/');

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!isPageImg){
      const hit = await cache.match(req, { ignoreSearch: url.pathname.endsWith('/') });
      // 后台静默刷新，保证下次进入是新版本
      fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {});
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (isPageImg){
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      if (req.mode === 'navigate'){
        const nav = (await cache.match('./')) || (await cache.match('./index.html'));
        if (nav) return nav;
      }
      throw err;
    }
  })());
});
