self.addEventListener('message', function(event) {
    if (event.data.command === 'removeCaches') {
        caches.keys().then(function(cacheNames) {
            cacheNames.forEach(function(cacheName) {
                caches.delete(cacheName);
            });
        });
    }
});