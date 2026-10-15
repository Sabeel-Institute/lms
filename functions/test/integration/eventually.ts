/**
 * WAIT FOR WHAT A TRIGGER DOES, not for a time.
 *
 * The Functions emulator runs every trigger of the suite one at a time, so
 * a test's own trigger runs when the queue reaches it: at once on a quiet
 * run, seconds later behind another file's work. Reads `read` every quarter
 * second until `done` says so, for up to `ceilingMs`, and returns the last
 * reading, so the assertion after it says what was there. A healthy run
 * returns as soon as the trigger lands; only a backed-up one uses the time.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ceilingMs = 30_000,
): Promise<T> {
  const until = Date.now() + ceilingMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= until) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
}
