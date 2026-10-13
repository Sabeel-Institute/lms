import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AUDIT_PAGE, INSTITUTE_TIMEZONE, stampInZone } from '@sabeel/shared';
import { useDecidedStaff } from '../staff';
import { useStudents } from '../students';
import { Empty, Grid, Notice, Screen } from '../components/ui';
import { useAuditState, useMyAudit, type AuditRow } from '../ledger';

const NO_ENTRIES: AuditRow[] = [];
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Audit history, newest first. A manager passes their courseId (scoped); an admin
 * passes null for the global view.
 */
export function AuditScreen({
  courseId,
  title,
  allowed,
}: {
  courseId: string | null;
  title: string;
  /**
   * Whether this reader may see THIS view of the log.
   *
   * One route, two views: the institute-wide history is admin-only, a class's
   * own is open to the manager who runs it. A manager reaching `/audit` with no
   * course — by typing it, or by a bookmark — was served the wide view, whose
   * query the rules refuse, so the screen came up titled "All courses" with a
   * live-data error across the top. That reads as something broken rather than
   * as something not theirs.
   */
  allowed: boolean;
}) {
  // NOT SUBSCRIBED when the view is not this reader's: the wide query is one the
  // rules refuse a manager, and a refusal paints the live-data banner over the
  // explanation below.
  const entriesState = useAuditState(courseId, allowed);
  const entries = entriesState ?? NO_ENTRIES;
  /*
   * NAMES, NOT UIDS — on the one screen whose whole job is "who did what".
   *
   * Every row read `by admin IeW87L…` over `uid=HV70w7jevZ1X5VgqucMt4v6xt2Ev`,
   * which answers the question with a string nobody can match to a person
   * without going to another screen and comparing prefixes. Both directories
   * are already readable by everyone who can reach this screen — the ledger
   * resolves student names the same way, and staff can list `staffUsers` — so
   * the id was never the only thing available, just the only thing rendered.
   *
   * An id that resolves to nothing is still printed: a deleted account, or the
   * `seed-admin` an import writes, is better shown as itself than as blank.
   */
  const staff = useDecidedStaff(allowed);
  const students = useStudents(allowed);
  const people = useMemo(
    () =>
      new Map<string, string>([
        ...staff.map((r) => [r.uid, r.displayName] as const),
        ...students.map((r) => [r.uid, r.displayName] as const),
      ]),
    [staff, students],
  );

  if (!allowed) {
    return (
      <Screen title="Audit history" subtitle="Who changed what, and when" width="list">
        <Notice tone="info">
          The institute-wide history is for administrators. Open one of your courses and choose
          Audit history to see everything that happened in it.
        </Notice>
      </Screen>
    );
  }

  return (
    <Screen title={title} subtitle="Every change, who made it and when" width="list">
      {/* A handle for "the log rendered", which the layout sweep anchors on —
          this screen is a read-only list and has no control of its own to wait
          for. NAMED BY WHAT IT FOUND: anchoring on a wrapper around both states
          made a manager's course-scoped read failing closed indistinguishable
          from a course with no history, on a screen the sweep also excuses from
          the starvation guard. */}
      {/* SAYS SO WHEN IT IS FULL. The query stops at `AUDIT_PAGE`, and a list
          that simply ends reads as "this is the whole history" — which on the
          one screen people consult to establish what happened is the wrong
          answer given confidently. */}
      {entries.length >= AUDIT_PAGE ? (
        <Notice tone="info">
          The most recent {AUDIT_PAGE} changes. Older history is kept but is not shown here.
        </Notice>
      ) : null}
      <View testID={entries.length === 0 ? 'audit-empty' : 'audit-list'}>
        {entriesState === null && allowed ? (
          <Empty>Checking…</Empty>
        ) : entries.length === 0 ? (
          <Empty>No audit entries yet.</Empty>
        ) : (
          <Grid min={330}>
            {entries.map((e) => (
              <AuditCard key={e.id} entry={e} people={people} />
            ))}
          </Grid>
        )}
      </View>
    </Screen>
  );
}

/** Which target keys name a PERSON, and what to call them in the row. */
const PERSON_TARGETS: Record<string, string> = {
  studentUid: 'student',
  uid: 'account',
};

/**
 * A staff member's own actions, wherever they happened.
 *
 * The same card as the class-scoped view, from a different query: `actorUid ==
 * me`. It exists because a manager may create a student account without naming
 * a course, and that entry belongs to no class — so the one action a manager
 * most needs to be able to account for was the one their audit view could not
 * show them.
 */
export function MyAuditScreen({ uid }: { uid: string }) {
  const entries = useMyAudit(uid);
  const staff = useDecidedStaff(true);
  const students = useStudents(true);
  const people = useMemo(
    () =>
      new Map<string, string>([
        ...staff.map((r) => [r.uid, r.displayName] as const),
        ...students.map((r) => [r.uid, r.displayName] as const),
      ]),
    [staff, students],
  );

  return (
    <Screen title="Your actions" subtitle="Everything you have changed, newest first" width="list">
      {entries.length >= AUDIT_PAGE ? (
        <Notice tone="info">
          The most recent {AUDIT_PAGE} changes. Older history is kept but is not shown here.
        </Notice>
      ) : null}
      <View testID={entries.length === 0 ? 'my-audit-empty' : 'my-audit-list'}>
        {entries.length === 0 ? (
          <Empty>You have not changed anything yet.</Empty>
        ) : (
          <Grid min={330}>
            {entries.map((e) => (
              <AuditCard key={e.id} entry={e} people={people} />
            ))}
          </Grid>
        )}
      </View>
    </Screen>
  );
}

function AuditCard({ entry: e, people }: { entry: AuditRow; people: Map<string, string> }) {
  // A list of uids in a detail — the managers added to or removed from a
  // course — reads as names where the directory has them, like a target does.
  const named = (v: unknown) =>
    Array.isArray(v) ? v.map((u) => people.get(String(u)) ?? String(u)).join(', ') : String(v);
  const detail = e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${named(v)}`).join(' · ') : '';
  const targets = Object.entries(e.targets ?? {})
    .map(([k, v]) =>
      PERSON_TARGETS[k] ? `${PERSON_TARGETS[k]}: ${people.get(String(v)) ?? v}` : `${k}=${v}`,
    )
    .join(' · ');
  // A name when the directory has one; the raw uid when it does not — a deleted
  // account is still evidence, and a shortened id is worse than a full one when
  // it is the only handle left.
  const actor =
    e.actorRole === 'system'
      ? 'system'
      : `${e.actorRole} ${people.get(e.actorUid) ?? e.actorUid}`;
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.action}>{ACTION_LABELS[e.action] ?? RETIRED_ACTION_LABELS[e.action] ?? e.action}</Text>
        {/* The institute's clock, not the reader's — see `stampInZone`. This
            log is the record of when something happened, and a manager abroad
            reading their own zone dates an override to the wrong day. */}
        <Text style={styles.time}>{stampInZone(INSTITUTE_TIMEZONE, e.at)}</Text>
      </View>
      <Text style={styles.by}>by {actor}</Text>
      {targets ? <Text style={styles.targets}>{targets}</Text> : null}
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

/**
 * Friendlier labels; unknown actions fall back to the raw name.
 *
 * EVERY action a callable writes needs an entry, or the fallback prints a
 * camelCase function name in a list of English sentences — `submitAttendance`
 * sat between "Created course" and "Changed recording status" for exactly that
 * reason. Adding an `auditedCall` means adding a line here.
 *
 * CHECKED, because the rule above was already broken in both directions and
 * nothing noticed: every Zoom import rendered as `importZoomRecording`, while
 * `assignCatchup` and `updateRecording` labelled actions no callable had
 * written since the catch-up concept was removed.
 * `functions/test/unit/auditLabels.test.ts` compares this map with the actions
 * the server actually writes, in both directions.
 */
const ACTION_LABELS: Record<string, string> = {
  createCohort: 'Created cohort',
  setCohortArchived: 'Archived/unarchived cohort',
  renameCohort: 'Renamed cohort',
  createCourse: 'Created course',
  updateCourse: 'Updated course',
  setCourseManagers: 'Set course managers',
  createStudent: 'Created student',
  setStudentAccess: 'Changed student access',
  createEnrollment: 'Enrolled student',
  setEnrollmentActive: 'Changed enrollment',
  createSession: 'Created session',
  updateSession: 'Edited session',
  deleteSession: 'Deleted session',
  submitAttendance: 'Submitted attendance',
  createRecording: 'Created recording',
  deleteRecording: 'Deleted recording',
  finalizeRecordingUpload: 'Uploaded audio',
  setRecordingStatus: 'Changed recording status',
  removeRecordingMedia: 'Removed a file',
  editRecordingMedia: 'Changed a recording’s files',
  importZoomFiles: 'Imported from Zoom',
  retryZoomImport: 'Retried a Zoom import',
  setStaffAccess: 'Changed staff access',
  overrideCompletion: 'Overrode completion',
  clearCompletionOverride: 'Removed override',
  authProvision: 'Staff account created',
  authReject: 'Rejected sign-up',
};

/**
 * Actions no callable writes any more, which the log still holds from before a
 * rename. Kept apart from `ACTION_LABELS` so that map stays exactly the set the
 * server writes today, which is what the test above checks.
 */
const RETIRED_ACTION_LABELS: Record<string, string> = {
  clearRecordingAudio: 'Removed audio',
  importZoomRecording: 'Imported from Zoom',
};

const styles = StyleSheet.create({
  row: {
    // Fills the grid cell it is given, so a row of these ends level instead
    // of ragged with its actions at three different heights.
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  action: { fontSize: 15, fontWeight: '700', color: t.text.primary, flex: 1 },
  // secondary, not muted. "When" is half of what this screen's own subtitle
  // promises, and taupe is ~2.7:1 — BRAND.md's captions-only colour.
  time: { fontSize: 12, color: t.text.secondary },
  by: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  targets: { fontSize: 12, color: t.text.secondary, marginTop: spacing(1), fontVariant: ['tabular-nums'] },
  // secondary, not accent. `text.accent` is the app's link colour, and an
  // override's reason is content — set in raspberry it was the loudest line on
  // the card and read as something to click.
  detail: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
});
