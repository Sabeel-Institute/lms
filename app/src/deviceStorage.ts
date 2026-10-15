import { captureError } from './sentry';

/**
 * Storage the device refused — a private window, blocked site data —
 * reported ONCE for the whole app: it is the device's condition, and the
 * player writes its place and its listening every second.
 */
let reported = false;

export function storageRefused(e: unknown, source: string): void {
  if (reported) return;
  reported = true;
  captureError(e, { source });
}
