import { FIREBASE_PROJECT_ID } from '@sabeel/shared';

// Firebase WEB APP client config — NOT a secret (it ships in every client bundle).
// From Firebase console → Project settings → Your apps → Web app ("Sabeel LMS
// web"), or `firebase apps:sdkconfig WEB <appId>`.
//
// The project id comes from `@sabeel/shared`, the one place that names it.
// Under EXPO_PUBLIC_USE_EMULATORS=1, firebase.ts overrides projectId to the demo
// project and the bucket to the emulator's, so a dev/emulator bundle never
// touches the real values.
//
// `authDomain` must be the HOSTING domain (<project>.web.app), not the
// console-supplied firebaseapp.com. Hosting serves /__/auth/* itself, keeping
// the sign-in redirect same-origin — required in storage-partitioned in-app
// webviews, where the cross-domain helper dies with "missing initial state"
// (docs/DEPLOY.md). Both domains are authorized for sign-in, so it can be
// switched back without console work if it ever needs to be.
//
// No `storageBucket`: media is not in Firebase. It lives in Cloudflare R2 and
// the app only ever sees URLs the server signed (docs/plans/MEDIA-ON-CLOUDFLARE.md).
export const firebaseConfig = {
  apiKey: 'AIzaSyC6N2JTrBAwLQ9zpwLdoAbQNt0nrOunwQQ',
  authDomain: `${FIREBASE_PROJECT_ID}.web.app`,
  projectId: FIREBASE_PROJECT_ID,
  messagingSenderId: '226338267845',
  appId: '1:226338267845:web:2e285dbdf341e54bcac6ac',
};


/**
 * The WEB OAuth client id (client_type: 3) from google-services.json, used by
 * the native Google Sign-In SDK.
 *
 * It must be the *web* client id even on Android — passing the Android one is a
 * classic source of the opaque DEVELOPER_ERROR. Only used by the native seam;
 * the emulator dev sign-in path never reads it.
 */
export { GOOGLE_WEB_CLIENT_ID as WEB_CLIENT_ID } from '@sabeel/shared';

/**
 * The WEB PUSH public key (VAPID), from Firebase console → Project settings →
 * Cloud Messaging → Web configuration → "Generate key pair".
 *
 * Not a secret, in the same way `apiKey` above is not: it is the PUBLIC half of
 * the pair, and shipping it in every client bundle is precisely its job — the
 * browser needs it to subscribe. The private half never leaves Google.
 *
 * An empty value is still handled: `push.web.ts` returns no token and the
 * settings screen says the device cannot receive push, rather than throwing on
 * load. That is the state a fresh clone of a different project would be in.
 */
export const VAPID_PUBLIC_KEY =
  'BOpTic6Jgp0JHp363pNy5Bv21P1lYJYbDdIPiIfjfraBU--b-1YQ1cEZJQVWnDDEpAMS1LUcJfOVT9RCZZ2HEj0';
