const CACHE = 'otakutrack-v3';

self.addEventListener('install', e=>{
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>
      Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  const url = e.request.url;

  // Ne jamais cacher : HTML principal, Firebase, Jikan, API
  if(url.includes('index.html') ||
     url.endsWith('/') ||
     url.includes('firestore') ||
     url.includes('firebase') ||
     url.includes('jikan') ||
     url.includes('myanimelist') ||
     url.includes('anthropic')){
    e.respondWith(fetch(e.request).catch(()=> caches.match(e.request)));
    return;
  }

  // Pour le reste (fonts, scripts externes) : cache-first
  e.respondWith(
    caches.match(e.request).then(cached=>{
      if(cached) return cached;
      return fetch(e.request).then(resp=>{
        if(!resp || resp.status !== 200) return resp;
        const clone = resp.clone();
        caches.open(CACHE).then(c=>c.put(e.request, clone));
        return resp;
      });
    })
  );
});
