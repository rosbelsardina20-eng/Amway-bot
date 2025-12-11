self.addEventListener('install', function(event) {
  event.waitUntil(caches.open('app-cache-v1').then(function(cache){
    return cache.addAll(['/','/index.html','/manifest.json']);
  }));
});
self.addEventListener('fetch', function(event){
  event.respondWith(caches.match(event.request).then(function(resp){ return resp || fetch(event.request); }));
});
