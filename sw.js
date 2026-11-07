// Spike Radar service worker v2 — lets the open app show phone notifications
self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:"window"}).then(c=>c.length?c[0].focus():self.clients.openWindow("./")))});
