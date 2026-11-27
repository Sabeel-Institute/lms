import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_PAGE,
  INSTITUTE_TIMEZONE,
  auditClassName,
  describeAuditEntry,
  stampInZone,
  unbreakableDate,
  type CurrentName,
} from '@sabeel/shared';
import { useDecidedStaff } from '../staff';
import { useStudents } from '../students';
import { Empty, Grid, Notice, Screen, useGridCell } from '../components/ui';
import { useAuditState, useMyAudit, type AuditRow } from '../ledger';
import { useAllCourses, useCohortName, useMyCourses, type CourseRow } from '../structure';

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
  // The institute-wide view spans courses, so each entry names its own; a
  // course's view leaves its course off every entry.
  const courseNames = useCourseNames(useAllCourses(allowed && courseId === null));
  const current = useCurrentNames(people, courseNames);

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
          <Grid min={330} rows>
            {entries.map((e) => (
              <AuditCard key={e.id} entry={e} people={people} current={current} courseId={courseId} />
            ))}
          </Grid>
        )}
      </View>
    </Screen>
  );
}

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
  // A manager acts only in the courses they run, so these name every one.
  const courseNames = useCourseNames(useMyCourses(uid));
  const people = useMemo(
    () =>
      new Map<string, string>([
        ...staff.map((r) => [r.uid, r.displayName] as const),
        ...students.map((r) => [r.uid, r.displayName] as const),
      ]),
    [staff, students],
  );
  const current = useCurrentNames(people, courseNames);

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
          <Grid min={330} rows>
            {entries.map((e) => (
              <AuditCard key={e.id} entry={e} people={people} current={current} courseId={null} />
            ))}
          </Grid>
        )}
      </View>
    </Screen>
  );
}

/**
 * Each course's name and term, by id: "Hikam Foundations · Autumn 2026", as
 * an entry names it (`auditClassName`), so "then …" compares like with like.
 * The term, because a course name recurs from one term to the next.
 */
function useCourseNames(courses: CourseRow[]): Map<string, string> {
  const cohortNameOf = useCohortName();
  return useMemo(() => new Map(courses.map((c) => [c.id, auditClassName(c, cohortNameOf(c.cohortId))])), [courses, cohortNameOf]);
}

/** Today's names of the people, classes and cohorts this screen has in hand. */
function useCurrentNames(people: Map<string, string>, courseNames: Map<string, string>): CurrentName {
  const cohortNameOf = useCohortName();
  return useCallback<CurrentName>(
    (kind, id) =>
      kind === 'person' ? people.get(id) : kind === 'class' ? courseNames.get(id) : kind === 'cohort' ? cohortNameOf(id) || undefined : undefined,
    [people, courseNames, cohortNameOf],
  );
}

function AuditCard({
  entry: e,
  people,
  current,
  courseId,
}: {
  entry: AuditRow;
  people: Map<string, string>;
  current: CurrentName;
  /** The course this screen is about, which its entries need not repeat. */
  courseId: string | null;
}) {
  const inGrid = useGridCell();
  /*
   * IN WORDS, NEVER IDS (`describeAuditEntry`). Every id an entry touched is
   * named: today's name for a person, class or cohort, with the name it had
   * then when that differs; the name at the time for a session, recording,
   * assignment or file; and a sentence for one no longer in the app.
   */
  const words = describeAuditEntry(e, current, courseId);
  // A date inside a line never breaks at its hyphens (`unbreakableDate`):
  // "(2026-11-" over "25)" split a session's date at a phone's width.
  const whole = (line: string) => line.replace(/\d{4}-\d{2}-\d{2}/g, unbreakableDate);
  const about = words.about.map(whole);
  const details = words.details.map(whole);
  const actor =
    e.actorRole === 'system' ? 'System' : `${people.get(e.actorUid) ?? 'An account no longer in the app'} (${e.actorRole})`;
  return (
    <View style={[styles.row, inGrid]}>
      <View style={styles.head}>
        <Text style={styles.action}>{AUDIT_ACTION_LABELS[e.action] ?? e.action}</Text>
        {/* The institute's clock, not the reader's — see `stampInZone`. This
            log is the record of when something happened, and a manager abroad
            reading their own zone dates an override to the wrong day. */}
        <Text style={styles.time}>{stampInZone(INSTITUTE_TIMEZONE, e.at)}</Text>
      </View>
      <Text style={styles.targets}>By {actor}</Text>
      {about.map((line) => (
        <Text key={line} style={styles.targets}>
          {line}
        </Text>
      ))}
      {details.length ? <Text style={styles.detail}>{details.join(' · ')}</Text> : null}
    </View>
  );
}

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
  targets: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1), fontVariant: ['tabular-nums'] },
  // secondary, not accent. `text.accent` is the app's link colour, and an
  // override's reason is content — set in raspberry it was the loudest line on
  // the card and read as something to click.
  detail: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
});
