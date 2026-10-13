import './setup';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  todayInZone,
  type AssignmentDoc,
} from '@sabeel/shared';
import { notifyAttendanceMissing, notifyLastDay, notifyRecordingReady } from './notifyJobs';
import { notifyHandInLastDay } from './notifyCoursework';
import { reportError } from './sentry';
import { SENTRY_DSN } from './reported';

/**
 * The two ways a notification is triggered: a grant appearing, and the morning.
 *
 * Bindings only — every decision is in `notifyJobs`, which the integration tests
 * drive directly with the FCM sender stubbed. There is no FCM emulator, so that
 * split is the difference between logic that is tested and logic that is hoped
 * for.
 */

/**
 * A device registered to one account stops being registered to any other.
 *
 * SIGN-OUT CANNOT BE RELIED ON TO DO THIS. `unregisterThisDevice` runs while the
 * credential still exists and is bounded so the button cannot hang offline — but
 * a delete that has not been acknowledged when `signOut()` drops the credential
 * is never sent, and neither is one interrupted by the app being killed. The
 * registration that survives is a perfectly valid token, so `notifyOnce`'s
 * pruning never touches it: the next "a recording is ready" for the student who
 * signed OUT is delivered to the phone the next student is holding. That is a
 * privacy leak and the most confusing notification this app could send.
 *
 * So the claim is settled server-side, where no credential is needed: a token is
 * registered to exactly one account, the most recent one. This also covers the
 * ordinary shared-device case, where nothing failed at all — two students on one
 * phone, the first signing out cleanly, is the same end state.
 *
 * The collection-group query needs `devices.token` indexed at COLLECTION_GROUP
 * scope; Firestore does not create those automatically, so it is declared in
 * `firestore.indexes.json` — along with the collection-scope entries, because a
 * `fieldOverrides` block REPLACES the automatic set for that field rather than
 * adding to it. `scripts/check-query-shapes.mjs` sends this shape against the
 * real project, which is the only place a missing index shows up: the emulator
 * serves any shape, and the symptom in production would be a device quietly
 * staying registered to a previous account.
 */
export const onDeviceRegistered = onDocumentWritten(
  { document: `${COLLECTIONS.notifications}/{uid}/devices/{token}`, secrets: [SENTRY_DSN] },
  async (event) => {
    try {
      /*
       * ON EVERY WRITE, NOT ONLY THE FIRST.
       *
       * `registerThisDevice` uses `setDoc`, which Firestore evaluates as an
       * UPDATE once the row exists — so a re-registration fired no create at
       * all. With `onDocumentCreated`, a duplicate pair that ever formed was
       * permanent: neither account re-registering could clear it, and one
       * transient failure of one invocation (a still-building index right after
       * a deploy, say) was enough to form one. It also gives the sweep a way to
       * run over registrations that predate it, since signing in re-writes them.
       *
       * A DELETE is the one write to ignore: the document is gone, so there is
       * nothing to keep, and sweeping on it would race the deletes this handler
       * itself performs.
       */
      if (!event.data?.after.exists) return;
      const rows = await getFirestore()
        .collectionGroup('devices')
        .where('token', '==', event.params.token)
        .get();
      /*
       * KEEP THE NEWEST, not "the one this invocation fired for".
       *
       * Trigger delivery is not ordered. Two registrations landing close
       * together produce two invocations that can run in either order, and a
       * trigger that trusts its own params to be the winner then has each one
       * delete the other's row — both accounts lose the device, which is worse
       * than the leak this exists to close. An order both invocations agree on
       * makes them converge on the same survivor.
       *
       * `updateTime`, NOT the document's own `registeredAt`. That field is written
       * by the client, so a student who wrote `Number.MAX_SAFE_INTEGER` onto
       * their own row would win every future comparison — and a backwards clock
       * correction between two honest registrations does the same by accident.
       * `updateTime` is Firestore's, at nanosecond resolution; the path breaks a
       * tie so agreement does not depend on sort stability.
       *
       * WHAT THIS STILL DOES NOT STOP, stated rather than glossed. FCM tokens
       * carry no proof of possession, and the rules cannot invent one: any
       * active account may write ANY token string under its own uid. So a
       * student who has used a shared device — and therefore read its token off
       * their own registration — can re-register it later from anywhere, become
       * the newest row, and have this sweep delete the current holder's. That
       * turns a leak (their notifications reaching a device someone else is
       * holding, which is what happened before the sweep existed) into a leak
       * plus a silent denial for the rightful holder.
       *
       * It is not a reason to drop the sweep: the failure it fixes is the
       * ordinary one — a sign-out whose unregister never reached the backend —
       * and that has no attacker in it at all. But the residual is real, it is
       * bounded to devices the attacker has personally used, and it is written
       * down in `TODO.md` rather than left implied by an over-confident comment.
       */
      const ordered = rows.docs
        .map((d) => ({ ref: d.ref, at: d.updateTime.toMillis() }))
        .sort((a, b) => b.at - a.at || a.ref.path.localeCompare(b.ref.path));
      await Promise.all(ordered.slice(1).map((r) => r.ref.delete()));
    } catch (e) {
      await reportError(e, { source: 'onDeviceRegistered' });
      throw e;
    }
  },
);

/**
 * A grant became active: tell the student their recording is ready.
 *
 * Fires only on the false→true edge. Reconciles are frequent and idempotent —
 * every attendance correction rewrites every grant on the session — so firing on
 * any write would send one notification per staff edit. The `sent` marker would
 * catch it anyway; this keeps the work off the wire in the first place.
 */
export const onAssignmentWritten = onDocumentWritten(
  /*
   * RETRIED, because the one delivery a "recording ready" ever gets is claimed
   * inside. `notifyOnce` releases its claim and throws when FCM could not be
   * reached or delivered to nobody; without `retry` that throw was the end of
   * it — v2 triggers do not retry by default — and the message was lost for
   * good. The retry finds the claim open and tries again; a delivery that
   * succeeded is never repeated, because the marker then stands. A retry is
   * handed the ORIGINAL payload, so `notifyRecordingReady` treats `after` as
   * no more than the grant's id and reads the document for the rest.
   */
  { document: `${COLLECTIONS.assignments}/{assignmentId}`, secrets: [SENTRY_DSN], retry: true },
  async (event) => {
    try {
      const before = event.data?.before.data() as AssignmentDoc | undefined;
      const after = event.data?.after.data() as AssignmentDoc | undefined;
      if (!after?.active) return;
      if (before?.active) return;
      await notifyRecordingReady(getFirestore(), after, todayInZone(INSTITUTE_TIMEZONE));
    } catch (e) {
      await reportError(e, { source: 'onAssignmentWritten' });
      throw e;
    }
  },
);

/**
 * The morning sweep: last-day reminders for recordings and for hand-ins, and
 * attendance nobody has taken.
 *
 * 07:00 in the institute timezone, so "today" here is the same civil day the
 * due-date maths uses everywhere else — a UTC schedule would fire the reminder
 * on the wrong side of midnight for half the year.
 *
 * The repo's first scheduled function. It reuses `todayInZone` rather than
 * deriving the date itself, for the same reason the rules do not compute due
 * dates: one implementation of the rollover, or two that drift.
 */
export const onMorning = onSchedule(
  { schedule: '0 7 * * *', timeZone: INSTITUTE_TIMEZONE, secrets: [SENTRY_DSN] },
  async () => {
    try {
      const db = getFirestore();
      const today = todayInZone(INSTITUTE_TIMEZONE);
      const lastDay = await notifyLastDay(db, today);
      const handIn = await notifyHandInLastDay(db, today);
      const attendance = await notifyAttendanceMissing(db, today);
      console.log(`morning sweep ${today}: ${lastDay} last-day, ${handIn} hand-in, ${attendance} attendance`);
    } catch (e) {
      await reportError(e, { source: 'onMorning' });
      throw e;
    }
  },
);
