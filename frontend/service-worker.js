const ASSETS = __ASSETS__;
const notificationPath = /^\/?\?notification=[0-9a-f-]{36}$/i;
const notificationId = /^[0-9a-f-]{36}$/i;
self.addEventListener("install", (event) =>
    event.waitUntil(
        caches
            .open(SHELL)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting()),
    ),
);
self.addEventListener("activate", (event) =>
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key.startsWith("naryadai-shell-") && key !== SHELL)
                        .map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    ),
);
self.addEventListener("fetch", (event) => {
    const request = event.request,
        url = new URL(request.url),
        shellAsset = ASSETS.includes(url.pathname);
    // Deep links use the same public application shell, including offline reloads.
    // API responses and authenticated data never enter this cache.
    if (
        request.method === "GET" &&
        request.mode === "navigate" &&
        url.origin === self.location.origin &&
        /^\/(orders|reference|workload|analytics|employees|equipment)(\/|$)/.test(url.pathname)
    ) {
        event.respondWith(
            fetch(request).catch(() => caches.open(SHELL).then((cache) => cache.match("/index.html"))),
        );
        return;
    }
    if (
        request.method !== "GET" ||
        request.headers.has("Authorization") ||
        url.origin !== self.location.origin ||
        !shellAsset
    )
        return;
    event.respondWith(
        caches
            .open(SHELL)
            .then((cache) => cache.match(request, { ignoreVary: true }))
            .then(
                (hit) =>
                    hit ||
                    fetch(request).then((response) => {
                        if (!response.ok) return response;
                        const copy = response.clone();
                        void caches.open(SHELL).then((cache) => cache.put(request, copy));
                        return response;
                    }),
            ),
    );
});
self.addEventListener("push", (event) => {
    let data = { notification_id: "", title: "ТехНаряд", body: "Новое уведомление", urgent: false, url: "/" };
    try {
        const incoming = event.data.json();
        if (incoming && typeof incoming === "object") data = { ...data, ...incoming };
    } catch {
        /* Malformed push payload uses the safe default notification. */
    }
    const id =
        typeof data.notification_id === "string" && notificationId.test(data.notification_id)
            ? data.notification_id
            : "naryadai";
    const title = typeof data.title === "string" ? data.title.slice(0, 120) : "ТехНаряд";
    const body = typeof data.body === "string" ? data.body.slice(0, 240) : "Новое уведомление";
    const urgent = data.urgent === true;
    const url = typeof data.url === "string" && notificationPath.test(data.url) ? data.url : "/";
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: "/icon-192.png",
            badge: "/notification-badge.png",
            tag: id,
            renotify: urgent,
            requireInteraction: urgent,
            data: { url },
            ...(urgent ? { vibrate: [100, 80, 100] } : {}),
        }),
    );
});
// A suspended mobile window can reject navigate/focus. Keep opening inside
// notificationclick.waitUntil and fall back if that WindowClient is no longer usable.
async function openNotification(destination) {
    let windows = [];
    try {
        windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    } catch {
        // An unavailable client list must not prevent a new window from opening.
    }
    const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin && client.frameType === "top-level",
    );
    if (existing) {
        try {
            // Bring the app forward before navigating: a background document may be inactive.
            const focused = await existing.focus();
            const navigated = await focused.navigate(destination);
            if (navigated) return;
        } catch {
            // The selected client may have closed, frozen or been replaced during this click.
        }
    }
    const opened = await clients.openWindow(destination);
    if (opened) {
        try {
            await opened.focus();
        } catch {
            // openWindow already opened the app; some browsers reject an extra focus call.
        }
    }
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const path =
        typeof event.notification.data?.url === "string" && notificationPath.test(event.notification.data.url)
            ? event.notification.data.url
            : "/";
    const destination = new URL(path, self.location.origin).href;
    event.waitUntil(openNotification(destination));
});
