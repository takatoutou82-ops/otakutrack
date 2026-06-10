const CACHE = 'otakutrack-v1';
const ASSETS = [
  '/otakutrack/',
  '/otakutrack/index.html',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll([
      '/otakutrack/',
      '/otakutrack/index.html'
    ])).catch(()=>{})
  );
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
  // Ne pas intercepter les requêtes Firebase/API
  if(e.request.url.includes('firestore') ||
     e.request.url.includes('firebase') ||
     e.request.url.includes('jikan') ||
     e.request.url.includes('myanimelist') ||
     e.request.url.includes('anthropic')){
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached=>{
      if(cached) return cached;
      return fetch(e.request).then(resp=>{
        if(!resp || resp.status !== 200) return resp;
        const clone = resp.clone();
        caches.open(CACHE).then(c=>c.put(e.request, clone));
        return resp;
      }).catch(()=> caches.match('/otakutrack/index.html'));
    })
  );
});
