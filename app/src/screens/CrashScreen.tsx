/**
 * A SCREEN THAT THROWS, ON PURPOSE, registered in emulator builds only (the
 * constant that keeps the dev sign-in rows out of production keeps this out
 * too, and smoke:prod checks those rows are absent). The browser suite opens
 * it to show that a screen which cannot be drawn says so inside the app, with
 * the bar still working (ScreenBoundary), rather than a white page.
 */
export function CrashScreen(): never {
  throw new Error('This screen throws on purpose, to show a screen that cannot be drawn is contained.');
}
