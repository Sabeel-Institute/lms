/**
 * Push notifications: the three messages, the per-person switches, and the
 * copy.
 *
 * Everything here is PURE — no Firestore, no `admin.messaging()`, no clock — so
 * the decision "should this person get this message, and what does it say?" is
 * unit-testable. That matters more here than elsewhere: there is no FCM
 * emulator, so delivery itself can only ever be verified on a real device, and
 * anything that can be tested without one should be.
 */

/**
 * The three messages, and deliberately no more.
 *
 *  - `recordingReady` — a student was excused and the recording is published.
 *    Under the excused-only policy this is also "you now have access", so
 *    without it a student has no way to learn a recording appeared.
 *  - `lastDay` — the morning of the due date, if not yet complete. There is no
 *    day-after reminder: once the deadline passes access has closed, so the
 *    message could only say "you missed it", which is a scolding with no action
 *    attached.
 *  - `attendanceMissing` — staff, when a session's date has passed and
 *    attendance was never submitted. Load-bearing under this policy: no
 *    attendance means nobody is granted anything, so an un-taken sheet silently
 *    locks a whole class out of a published recording.
 */
export type NotificationKind = 'recordingReady' | 'lastDay' | 'attendanceMissing';

export const NOTIFICATION_KINDS: NotificationKind[] = [
  'recordingReady',
  'lastDay',
  'attendanceMissing',
];

/** Which kinds each population can receive, for rendering the settings screen. */
export const STUDENT_KINDS: NotificationKind[] = ['recordingReady', 'lastDay'];
export const STAFF_KINDS: NotificationKind[] = ['attendanceMissing'];

/**
 * The Android notification channel every push is posted to.
 *
 * Shared because BOTH sides have to name it and neither can check the other:
 * the app creates the channel, the server addresses it by id, and a typo on
 * either side is silent. A send naming no channel does not fail — Android posts
 * it to FCM's own `fcm_fallback_notification_channel`, which it labels
 * **"Miscellaneous"** in the app's notification settings.
 *
 * That fallback is exactly what was happening, confirmed on a device on
 * 2026-08-28: `push.ts` created a channel called "Class recordings" that
 * nothing ever posted to, because `fcmSender` sent no channel at all. The
 * sibling kanban app hit the identical bug and fixed it the same way; this is
 * deliberately its shape, down to the constant names, so the two do not drift.
 *
 * IMPORTANCE_HIGH, and it has to be right FIRST TIME: Android fixes a channel's
 * importance when the channel is created and an app may never raise it
 * afterwards — only the person can. That is also why this is a NEW channel id
 * rather than a correction to the old one, which already exists at DEFAULT
 * importance on every device that has run this app. HIGH matches the sibling
 * and means a deadline message can raise a heads-up banner; the old fallback
 * sat at DEFAULT, so this is the one deliberate change in how loud these are.
 */
export const PUSH_CHANNEL_ID = 'sabeel-alerts';
export const PUSH_CHANNEL_NAME = 'Recording alerts and deadlines';

/**
 * One person's switches. Document id is their uid; the only client-writable
 * document either population has, so the rules allow exactly these keys.
 *
 * Every field is optional and absent means ON. A person who has never opened
 * the settings screen has no document at all, and defaulting a missing document
 * to "off" would mean nobody is ever notified until they go looking for a screen
 * that exists to turn notifications off.
 */
export interface NotificationPrefsDoc {
  recordingReady?: boolean;
  lastDay?: boolean;
  attendanceMissing?: boolean;
  updatedAt?: number;
}

/** The keys a client may write. Mirrored in firestore.rules — keep them in step. */
export const PREF_KEYS: string[] = [...NOTIFICATION_KINDS, 'updatedAt'];

export function prefEnabled(
  prefs: NotificationPrefsDoc | null | undefined,
  kind: NotificationKind,
): boolean {
  return prefs?.[kind] !== false;
}

/**
 * A registered device, at `notifications/{uid}/devices/{token}`.
 *
 * Keyed BY the token so re-registering the same device is a no-op rather than a
 * slow leak of duplicates, and so a send failure can delete the exact row that
 * failed without a query.
 */
export interface DeviceTokenDoc {
  token: string;
  platform: 'android' | 'web';
  registeredAt: number;
}

/**
 * Proof a message was already sent, at `notifications/{uid}/sent/{id}`.
 *
 * Trigger delivery is at-least-once, and the scheduled job runs every morning
 * whether or not yesterday's run finished — so without this a student would be
 * told twice about the same recording. Server-written; clients cannot read it,
 * because it answers a question nobody in the app asks.
 */
export interface SentNotificationDoc {
  kind: NotificationKind;
  targetId: string;
  at: number;
}

export function sentNotificationId(kind: NotificationKind, targetId: string): string {
  return `${kind}_${targetId}`;
}

// -------------------------------------------------------------------- copy --

export interface PushMessage {
  title: string;
  body: string;
}

/** Human labels for the settings screen. */
export const NOTIFICATION_LABEL: Record<NotificationKind, string> = {
  recordingReady: 'A recording is ready for me',
  lastDay: 'Last day for a recording',
  attendanceMissing: 'Attendance still not taken',
};

export const NOTIFICATION_DESCRIPTION: Record<NotificationKind, string> = {
  recordingReady: 'When a class you were excused from has a recording for you.',
  lastDay: 'On the morning of the day a recording closes, if you have not finished it.',
  attendanceMissing:
    'When a class meeting has passed and its attendance has not been submitted, so nobody can open the recording yet.',
};

/**
 * What each message says.
 *
 * The deadline is in every student message, because under this policy it is not
 * a nag but the day the recording disappears. Tone is the brief's: direct, adult,
 * never scolding — `check-text-sources` and the same review that governs screen
 * copy apply here, and a notification is the one piece of text that arrives
 * uninvited.
 */
export function recordingReadyMessage(courseName: string, title: string, dueDate: string): PushMessage {
  return {
    title: `${courseName}: a recording is ready`,
    body: `${title} — you were excused, so it is open to you until ${dueDate}.`,
  };
}

export function lastDayMessage(courseName: string, title: string, dueDate: string): PushMessage {
  return {
    title: `${courseName}: a recording closes today`,
    body: `${title} closes at the end of ${dueDate}.`,
  };
}

export function attendanceMissingMessage(
  courseName: string,
  title: string,
  date: string,
): PushMessage {
  return {
    title: `${courseName}: attendance not taken`,
    body: `${title} met on ${date} and its attendance has not been submitted. Nobody can hear its recording until it is.`,
  };
}

/**
 * What the notifications screen says about THIS device, one sentence per state.
 *
 * Here rather than in the screen because the layout sweep asserts that exactly
 * one of them is on screen — never none, never two. Restated in the test, the
 * sentence and its assertion drift apart, and the check then passes by finding
 * a string the app stopped saying.
 *
 * `blocked` has two, because only the native build can open its own settings
 * page: a browser has to be told where to look.
 */
export const PUSH_DEVICE_MESSAGE = {
  canAsk: 'Notifications are not enabled on this device.',
  ready: 'Notifications are enabled on this device.',
  blockedNative:
    'Notifications are blocked for this app on this device. Turn them back on in settings.',
  blockedWeb:
    "Notifications are blocked for this app in this browser. Allow them in the browser's site settings for this page, then reload it.",
  unavailable: "This device can't show notifications.",
} as const;
