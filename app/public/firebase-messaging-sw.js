/* eslint-env serviceworker */
/* global importScripts, firebase, self */
/**
 * Web push service worker.
 *
 * It exists to receive messages while the tab is closed — that is the whole of
 * its job, and it cannot be part of the app bundle: a service worker has to be a
 * separate file served from the origin root, or its scope is limited to the
 * directory it came from.
 *
 * `app/public/` is copied verbatim into `dist-web` by `expo export`, and Firebase
 * Hosting serves a matching real file before applying the `**` → `/index.html`
 * rewrite — so no rewrite exception is needed, but the file must genuinely reach
 * the export. Check the EXPORTED bundle, never the dev server.
 *
 * The compat SDK, deliberately: a service worker has no bundler, and the modular
 * SDK cannot be loaded from a plain `importScripts`. The version is pinned
 * rather than floating, because a worker that fails to parse does not fall back
 * to anything — push simply stops, silently.
 */
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

// Only the messaging fields matter here; this worker never reads Firestore or
// signs anyone in. `apiKey` and `projectId` are not secrets — they ship in the
// app bundle already. A worker has no bundler, so these are literals;
// `serviceWorkerConfig.test.ts` holds them to `firebase-config.ts`.
firebase.initializeApp({
  apiKey: 'AIzaSyC6N2JTrBAwLQ9zpwLdoAbQNt0nrOunwQQ',
  projectId: 'oursabeel-lms',
  messagingSenderId: '226338267845',
  appId: '1:226338267845:web:2e285dbdf341e54bcac6ac',
});

// Registering messaging is enough for a closed or hidden tab: the SDK shows the
// notification payload itself when no window of this origin is visible, and its
// click opens the link the server set. A custom onBackgroundMessage handler
// here would produce a SECOND banner alongside the automatic one.
//
// With a window visible the SDK draws nothing and forwards the payload to the
// page, which shows it through this registration (push.web.ts,
// showForegroundPush) — so the click on THAT banner lands here too, and the
// SDK's own click handler ignores it (no FCM_MSG in its data). This one acts
// only on notifications the page shaped, marked `data.page`, and leaves the
// SDK's to the SDK: a window of ours that is open is brought forward and told
// where the message points (pushTaps.web.ts), so the tap opens the assignment
// in the tab already open rather than a second copy of the app; with none
// open, the link — the app's address plus that path — is opened.
firebase.messaging();

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data;
  if (!data || !data.page) return;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => 'focus' in c);
      if (!open) return self.clients.openWindow(data.link);
      return open.focus().then((tab) => {
        if (data.path) (tab || open).postMessage({ type: 'open-path', path: data.path });
      });
    }),
  );
});
