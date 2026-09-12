// FruitsHub Web Push Notifications Service Worker
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { title: "FruitsHub Alert", body: event.data.text() };
        }
    }
    const title = data.title || "FruitsHub Update Notice";
    const options = {
        body: data.body || "A new update for FruitsHub is ready to execute in Blox Fruits!",
        icon: "/assets/logo.png",
        badge: "/assets/logo.png",
        data: { url: data.url || "https://fruitshub.onrender.com" }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || "https://fruitshub.onrender.com";
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.includes(targetUrl) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
