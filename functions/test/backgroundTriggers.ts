/**
 * Switch the functions emulator's background triggers off, or back on, through
 * the emulator hub that `firebase emulators:exec` names in
 * `FIREBASE_EMULATOR_HUB`. While they are off, a write fires nothing: no
 * `onSessionWritten`, no `onRecordingWritten`, and no event is kept for later.
 */
export async function setBackgroundTriggers(on: boolean): Promise<void> {
  const hub = process.env.FIREBASE_EMULATOR_HUB;
  if (!hub) throw new Error('FIREBASE_EMULATOR_HUB is not set: run under `firebase emulators:exec`');
  const action = on ? 'enableBackgroundTriggers' : 'disableBackgroundTriggers';
  const res = await fetch(`http://${hub}/functions/${action}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`${action} answered ${res.status}: ${await res.text()}`);
}
