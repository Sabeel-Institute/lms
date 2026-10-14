// Web side of the auth-init seam (native sibling: authInit.ts).
import type { FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';

/**
 * The persistence `getAuth` would choose, WITHOUT its popup/redirect resolver.
 *
 * `getAuth` installs that resolver, and on every mobile browser and on Safari
 * Auth's start-up then waits for Google's sign-in iframe (api.js, gapi, the
 * /__/auth/iframe page) before it says who is signed in: 1.5 s more on a cold
 * phone load, a second on every return, for a door only staff use. Google
 * sign-in hands the resolver over itself (`google.web.ts`); a session already
 * stored keeps working, since the persistence is the same.
 */
export function initAuth(app: FirebaseApp): Auth {
  return initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
  });
}
