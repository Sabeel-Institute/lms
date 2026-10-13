/**
 * A PICKER THAT WILL NOT OPEN says so in words. Native only: the web's pickers
 * are file inputs, which cannot fail to open.
 *
 * Once Android has rebuilt the app's screen — the display size or the language
 * changed while it was open — the camera and the phone's file browser refuse
 * to start until the app is opened again: expo-modules-core throws
 * "Attempting to launch an unregistered ActivityResultLauncher" (found on the
 * device pass, after a display-size change). What helps is opening the app
 * again, so that is what the person is told, not the Java exception.
 */
export async function opening<T>(what: 'camera' | 'file browser', open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (e) {
    console.warn('picker did not open', e);
    throw new Error(`The phone’s ${what} did not open. Close the app and open it again, then try once more.`);
  }
}
