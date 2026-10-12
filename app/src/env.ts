import { Platform } from 'react-native';

// Baked in at bundle time: EXPO_PUBLIC_USE_EMULATORS=1 npx expo start [--web]
//
// On a native DEBUG build this value comes from the environment that started
// METRO, not from the APK — the APK carries no EXPO_PUBLIC_* values to fix. If
// the flag looks unset on the emulator, restart Metro with `--clear` and the
// var set, then relaunch the app.
export const USE_EMULATORS = process.env.EXPO_PUBLIC_USE_EMULATORS === '1';

/**
 * True in a development bundle, false in a release build.
 *
 * `__DEV__` rather than a NODE_ENV comparison: Metro substitutes it as a literal
 * at build time on both native and web, so a `if (__DEV__)` branch can actually
 * be eliminated, and it is the constant React Native itself is defined in terms
 * of. NODE_ENV is not reliably set on a native release build.
 */
export const IS_DEV = __DEV__;

// The Android emulator reaches the host machine at 10.0.2.2.
// Web uses the LITERAL 127.0.0.1, never 'localhost': the Firebase emulators bind
// to IPv4 only, while 'localhost' can resolve to IPv6 ::1 first — the request
// then fails at connect, which surfaces as a CORS error ("no
// Access-Control-Allow-Origin") because there is no response to carry headers.
export const EMULATOR_HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';

/**
 * The emulator ports this checkout owns.
 *
 * SOURCE LITERALS, never `EXPO_PUBLIC_*`. On a native debug build those come
 * from the environment that started METRO, and one Metro serves every Sabeel
 * project on this machine — an env-driven port would make the app's backend
 * address a property of an unrelated process's environment. An env-with-default
 * is worse still: it fails *toward* the collision, because an unset or mistyped
 * var falls back to a shared default and silently connects to a sibling repo's
 * emulator, which reads and writes happily.
 *
 * Kept in step with `firebase.json`, `scripts/lib/ports.mjs` and the shell
 * sweeps by `functions/test/unit/emulatorPorts.test.ts`.
 */
export const EMULATOR_PORTS = {
  auth: 61302,
  firestore: 61300,
  functions: 61303,
  storage: 61307,
};
