import { initializeApp } from 'firebase/app';
import { connectAuthEmulator } from 'firebase/auth';
import { connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { EMULATOR_PROJECT_ID, REGION } from '@sabeel/shared';
import { firebaseConfig } from './firebase-config';
import { initAuth } from './authInit';
import { initDb } from './firestoreInit';
import { USE_EMULATORS, EMULATOR_HOST, EMULATOR_PORTS } from './env';

// Against the emulators, use the emulator's demo project id (what the emulator
// suite and tests run as) so the app reads/writes the same namespace. The
// Firestore emulator partitions by project id, and a mismatch shows up as
// writes that succeed while the client insists the document does not exist.
// The real projectId in firebaseConfig is for production only.
const app = initializeApp(
  USE_EMULATORS ? { ...firebaseConfig, projectId: EMULATOR_PROJECT_ID } : firebaseConfig,
);

// Exported for the web push seam, which needs the app instance to construct a
// Messaging instance. Nothing else should reach for it — the initialised
// services below are the intended surface.
export { app };

// initAuth is a platform seam: React Native has no default persistence in the
// Firebase JS SDK and must be wired to AsyncStorage at init, before any
// getAuth() call anywhere in the app.
export const auth = initAuth(app);
// Platform seam: persistent IndexedDB cache on web, memory cache on native
// (the JS SDK has no native persistence — see firestoreInit.ts). Must be the
// FIRST Firestore call on the app, before any getFirestore elsewhere.
export const db = initDb(app);
export const functions = getFunctions(app, REGION);

if (USE_EMULATORS) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
  connectFunctionsEmulator(functions, EMULATOR_HOST, EMULATOR_PORTS.functions);
}
