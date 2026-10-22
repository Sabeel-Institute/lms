import type { PushMessage } from '@sabeel/shared';

/**
 * The message a test push carries: `npx sabeel-ci send-test-push <token>
 * [path=<app path>]` sends it to one device, and `npm run check:push` sends it
 * to tokens that cannot exist, through the functions' own `fcm.ts` and
 * `apns.ts`, so a test push is shaped exactly as a notification is.
 *
 * The one field a notification carries is `path`, where a tap lands (an app
 * path, as `pushPaths` in @sabeel/shared builds it). With no fields a tap
 * opens the app. Any other field is nothing a notification of this app
 * carries, so there is no message for it: null, and the push is refused
 * before anything is sent.
 *
 * Imports nothing relative but types, so ci-tools runs it from source.
 */
export function testMessage(title: string, body: string, fields: Record<string, string>): PushMessage | null {
  const keys = Object.keys(fields);
  if (keys.some((key) => key !== 'path')) return null;
  return { title, body, path: fields.path ?? '' };
}
