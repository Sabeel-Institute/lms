import { useCourseCourseworkState } from '../coursework';
import { useCourseworkFigures } from './CourseworkListScreen';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Button,
  Card,
  CountsLine,
  EmailText,
  Empty,
  Grid,
  IconButton,
  ListRow,
  NavRow,
  Notice,
  Row,
  RowList,
  Screen,
  SectionTitle,
  SwitchRow,
  useGridCell,
} from '../components/ui';
import { RenameAction } from '../components/RenameAction';
import { Sheet } from '../components/Sheet';
import { INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { useCourseLedger } from '../ledger';
import { useDecidedStaff } from '../staff';
import { useStudentsState, type StudentRow } from '../students';
import {
  createEnrollment,
  setCourseManagers,
  setEnrollmentActive,
  sortByName,
  updateCourse,
  useRosterState,
  type CourseRow,
  type EnrollmentRow,
} from '../structure';
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import { exportCourseWorkbook } from '../workbookData';

const t = getTheme();
const NO_ROSTER: EnrollmentRow[] = [];
const NO_STUDENTS: StudentRow[] = [];

/**
 * One course: its settings (admin), its managers (admin), and its roster
 * (admin or a manager scoped to it).
 *
 * The roster query is constrained to this one courseId — required by the
 * enrollments rule, whose staff arm resolves a course lookup per row and is only
 * affordable when every row shares one course.
 */
export function CourseDetailScreen({
  cls,
  isAdmin,
  uid,
  onOpenSessions,
  onOpenCoursework,
  onOpenAttendance,
  onOpenStudent,
  onOpenAudit,
}: {
  cls: CourseRow;
  isAdmin: boolean;
  /** Who is exporting — named on the workbook's cover. */
  uid: string;
  onOpenSessions: () => void;
  onOpenCoursework: () => void;
  onOpenAttendance: () => void;
  onOpenStudent: (studentUid: string) => void;
  onOpenAudit: () => void;
}) {
  // The `State` variants: `null` until each listener answers, so the roster's
  // and the picker's empty sentences are answers, not placeholders.
  const rosterState = useRosterState(cls.id);
  const roster = rosterState ?? NO_ROSTER;
  const studentsState = useStudentsState(true);
  const students = studentsState ?? NO_STUDENTS;
  const staff = useDecidedStaff(isAdmin);
  // Only non-admin active staff can be *assigned* a course — an admin already has
  // every course, so offering to "make them a manager" is a no-op that reads as
  // broken (the confusion a solo admin hits: they can't usefully pick themself).
  const assignableManagers = useMemo(
    () => staff.filter((s) => s.status === 'active' && s.role !== 'admin'),
    [staff],
  );
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const ledger = useCourseLedger(cls.id, today);
  const { active: busy, run: once } = useOneAtATime();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Enrollment id whose removal is being confirmed, if any. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const enrolled = useMemo(
    () => roster.filter((r) => r.active).map((r) => r.studentUid),
    [roster],
  );
  const byUid = useMemo(
    () => new Map(students.map((s) => [s.uid, s])),
    [students],
  );
  const notEnrolled = useMemo(
    () => students.filter((s) => s.status === 'active' && !enrolled.includes(s.uid)),
    [students, enrolled],
  );
  /*
   * A TAPPED ROW STAYS LOCKED UNTIL THE ROSTER HOLDS THE STUDENT — the same
   * shape as a manager row below, for the same reason. `busy` clears when the
   * callable answers, but the row is listed until the roster snapshot lands on
   * its own channel, and a second tap in that window is a second enrolment: in
   * production two landed 24 ms apart, both succeeded, both were audited, and
   * the student's history said "Enrolled" twice. The server now refuses the
   * second (`createEnrollmentRecord`), which turns that tap into an error band
   * on a student who was in fact just added; this keeps the tap from being
   * sent at all.
   */
  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
  // The lock itself lives in a ref, read synchronously by the press: a second
  // click in the same frame sees the first before any render has caught up.
  const lock = useRef(new Set<string>());
  const publish = () => setAdding(new Set(lock.current));
  useEffect(() => {
    let changed = false;
    for (const uid of enrolled) changed = lock.current.delete(uid) || changed;
    if (changed) publish();
  }, [enrolled]);
  const enrol = (uid: string) => {
    if (lock.current.has(uid)) return;
    lock.current.add(uid);
    publish();
    void run(`add-${uid}`, async () => {
      try {
        await createEnrollment({ studentUid: uid, courseId: cls.id });
      } catch (e) {
        // Released on failure only: on success the roster releases it.
        lock.current.delete(uid);
        publish();
        throw e;
      }
    });
  };

  const run = (key: string, fn: () => Promise<void>) =>
    once(key, async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      }
    });

  /*
   * ITS OWN SLOT, not a prefix on the shared one.
   *
   * `setCourseManagers` sends the WHOLE array, so a second tap computed from the
   * pre-write list silently undoes the first — which is why the rows lock while
   * one is in flight. Reading that lock off `busy` broke it, because `busy` is
   * one slot every action on the page shares: tick a manager, then tap an "Add a
   * student" row before the write returns, and `busy` becomes `add-…`, every
   * manager row re-enables, and the spinner reverts to an unchecked tick because
   * `cls.managerUids` has not updated yet. Ticking a second manager then sends
   * `[...old, M2]`, which lands after the first write and drops M1's assignment
   * with no error anywhere.
   */
  const [managerBusy, setManagerBusy] = useState<{
    uid: string;
    want: boolean;
    /** The array as it stood when the write was sent. */
    was: string;
    /** Whether the callable has answered. */
    returned: boolean;
  } | null>(null);
  /*
   * HELD UNTIL THE SNAPSHOT AGREES, not until the callable answers.
   *
   * `cls` comes from a live listener on a separate channel, so it lands after
   * the HTTP response — and in that window the row re-enabled AND STILL DREW
   * UNCHECKED, because `on` reads `cls.managerUids`. That unchecked tick is
   * exactly what invites the next tap, and the next tap sends the pre-write
   * array again. Clearing on the response fixed the shared-slot half of this
   * and left the window.
   */
  /*
   * SETTLED = THE CALLABLE ANSWERED **AND** THE SNAPSHOT MOVED.
   *
   * Both halves are load-bearing, and each was tried alone.
   *
   * The response alone is not enough: `cls` comes from a live listener on a
   * separate channel, so in the gap the row re-enables and still draws
   * UNCHECKED — which is what invites the next tap, and the next tap sends the
   * pre-write array again.
   *
   * The snapshot alone is not enough either: another admin editing the same list
   * while your write is in flight moves the array, which released the lock
   * mid-write and reproduced the very clobber it exists to stop. And waiting for
   * the EXACT value has no exit at all when somebody else's edit is the one that
   * lands.
   *
   * So: wait for the response, then for any movement in the array. If that
   * movement is not the change that was asked for, the row simply draws the
   * truth, which is the honest outcome of two people editing at once.
   */
  const managerSettled = managerBusy
    ? managerBusy.returned &&
      (cls.managerUids.includes(managerBusy.uid) === managerBusy.want ||
        cls.managerUids.join(',') !== managerBusy.was)
    : true;
  const managerWriteInFlight = managerBusy !== null && !managerSettled;
  useEffect(() => {
    if (managerSettled) setManagerBusy(null);
  }, [managerSettled]);
  const runManager = async (uid: string, want: boolean, fn: () => Promise<void>) => {
    setManagerBusy({ uid, want, was: cls.managerUids.join(','), returned: false });
    setError(null);
    try {
      await fn();
      setManagerBusy((b) => (b && b.uid === uid ? { ...b, returned: true } : b));
    } catch (e) {
      setError(errorText(e));
      // The write failed, so no snapshot is coming — release the lock rather
      // than wedging every row behind a change that will never arrive.
      setManagerBusy(null);
    }
  };

  return (
    <Screen
      title={cls.name}
      status={cls.effectiveActive ? 'active' : 'inactive'}
      width="list"
      actions={
        isAdmin ? (
          <RenameAction
            name={cls.name}
            label="Rename course"
            testID="course-rename"
            onSave={(name) => updateCourse({ courseId: cls.id, name })}
          />
        ) : undefined
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!cls.effectiveActive ? (
        <Notice tone="info">
          {cls.archivedAccess
            ? 'This course is archived. Students can still play the recordings they were given.'
            : 'This course is archived and its recordings are closed.'}
        </Notice>
      ) : null}

      {/* THE WAY IN to what a teacher comes here for, each row saying what is
          there. Archiving the course changes none of the figures: the grants
          stay active and the counts stand as the term's record — it is
          archiving a RECORDING that closes grants. */}
      <RowList>
        <NavRow
          testID="nav-sessions"
          label="Sessions"
          caption={
            ledger.resolved ? (
              <CountsLine
                lead="Listening"
                counts={[
                  { value: ledger.rollup.total, label: 'required' },
                  { value: ledger.rollup.incomplete, label: 'not complete' },
                  { value: ledger.rollup.missed, label: 'missed', alarm: true },
                ]}
              />
            ) : (
              // Not three zeros: until the grants arrive those are the exact
              // wrong answer, stated as fact — see `useRecordingLedger`.
              'Counting the listening…'
            )
          }
          onPress={onOpenSessions}
        />
        <NavRow testID="nav-coursework" label="Assignments" caption={<AssignmentsCounts cls={cls} />} onPress={onOpenCoursework} />
        <NavRow testID="nav-attendance" label="Attendance report" onPress={onOpenAttendance} />
        <NavRow testID="nav-audit" label="Audit history" onPress={onOpenAudit} />
      </RowList>
      {/* THE ONE EXPORT: every student, every session, every grant of this
          course in one .xlsx — Summary, Students, Sessions, the Register and
          Recordings grids, Detail, Definitions. */}
      <Button
        testID="course-export"
        label="Export workbook"
        variant="quiet"
        hug
        busy={busy === 'export'}
        onPress={() => void run('export', () => exportCourseWorkbook(cls, uid))}
      />

      <SectionTitle
        action={
          <IconButton
            testID="roster-add"
            icon="person-add"
            label="Add a student to this course"
            onPress={() => setPickerOpen(true)}
          />
        }
      >
        Roster{rosterState === null ? '' : ` (${enrolled.length})`}
      </SectionTitle>
      {rosterState === null ? (
        <Empty>Checking the roster…</Empty>
      ) : enrolled.length === 0 ? (
        <Empty>Nobody is enrolled in this course yet.</Empty>
      ) : (
        <Grid min={320} rows>
          {/* By name. The list carries a remove button on every row, so an
              arbitrary order is a real chance of removing the wrong person. */}
          {sortByName(
            roster.filter((r) => r.active),
            (r) => byUid.get(r.studentUid)?.displayName ?? r.studentUid,
          )
            .map((r) => {
              const s = byUid.get(r.studentUid);
              const who = s?.displayName ?? r.studentUid;
              // The whole row opens the student's progress, so the × beside it is
              // one mis-tap away from silently unenrolling someone. It confirms IN
              // PLACE, replacing the row: leaving the row still tappable under
              // "remove?" is the flaw ConfirmDanger exists to prevent.
              if (confirmRemove === r.id) {
                return (
                  <ConfirmRow key={r.id}>
                    <Notice tone="error">
                      Remove {who} from this course? Their listening history is kept, and you
                      can add them back.
                    </Notice>
                    <Row>
                      <Button
                        testID={`roster-remove-confirm-${s?.email ?? r.studentUid}`}
                        label="Remove"
                        variant="danger"
                        busy={busy === `rm-${r.id}`}
                        onPress={() =>
                          void run(`rm-${r.id}`, async () => {
                            await setEnrollmentActive({
                              studentUid: r.studentUid,
                              courseId: cls.id,
                              active: false,
                            });
                            setConfirmRemove(null);
                          })
                        }
                      />
                      <Button
                        label="Cancel"
                        variant="quiet"
                        disabled={busy === `rm-${r.id}`}
                        onPress={() => setConfirmRemove(null)}
                      />
                    </Row>
                  </ConfirmRow>
                );
              }
              // The roster is a list to scan, so it is one line per student: the
              // email added nothing here (you identify classmates by name) and cost
              // a line each, which on a 20-student course is most of the screen.
              return (
                <ListRow
                  key={r.id}
                  testID={`student-ledger-${s?.email ?? r.studentUid}`}
                  name={who}
                  openLabel={`Open ${who}'s progress`}
                  onPress={() => onOpenStudent(r.studentUid)}
                  actionsPinned
                  actions={
                    /* A GREY ×, no tile. Removing someone from a course keeps
                       their listening history and can be undone — the
                       confirmation says so in as many words — and the
                       destructive register is this app's mark for permanent
                       deletion. A tinted control on every row made the loudest
                       thing on the page the one action nobody came here to
                       take. The CONFIRM is still danger-red, which is where the
                       weight belongs. */
                    <IconButton
                      testID={`roster-remove-${s?.email ?? r.studentUid}`}
                      icon="close"
                      bare
                      label={`Remove ${who} from this course`}
                      onPress={() => setConfirmRemove(r.id)}
                    />
                  }
                />
              );
            })}
        </Grid>
      )}

      {/* STAYS OPEN for several: each row leaves the list once the roster
          holds the student, and the × closes it. */}
      <Sheet visible={pickerOpen} title="Add a student" onClose={() => setPickerOpen(false)} closeAt="corner">
        {rosterState === null || studentsState === null ? (
          <Empty>Checking who can be added…</Empty>
        ) : notEnrolled.length === 0 ? (
          <Empty>
            {students.filter((s) => s.status === 'active').length === 0
              ? // The People screen has an Add button on the web only; on the
                // phone the sentence sent people to a screen where the thing
                // does not exist.
                Platform.OS === 'web'
                ? 'No student accounts yet. Create one from the People screen first.'
                : 'No student accounts yet.'
              : 'Every active student is already in this course.'}
          </Empty>
        ) : (
          notEnrolled.map((s) => {
            const inFlight = adding.has(s.uid);
            return (
              <Pressable
                key={s.uid}
                testID={`enrol-${s.email}`}
                accessibilityRole="button"
                accessibilityLabel={`Enrol ${s.displayName}`}
                // aria-*, as the manager row above: react-native-web maps no
                // accessibilityState, so it reached the DOM as nothing at all.
                aria-busy={inFlight}
                aria-disabled={inFlight}
                disabled={inFlight}
                onPress={() => enrol(s.uid)}
                style={[styles.pickRow, inFlight ? styles.pickRowBusy : null]}
              >
                <View style={styles.plus}>
                  {inFlight ? (
                    <ActivityIndicator size="small" color={t.text.secondary} />
                  ) : (
                    <Text style={styles.plusText}>+</Text>
                  )}
                </View>
                <View style={styles.pickText}>
                  <Text style={styles.name}>{s.displayName}</Text>
                  {inFlight ? <Text style={styles.hint}>Adding…</Text> : <EmailText email={s.email} />}
                </View>
              </Pressable>
            );
          })
        )}
      </Sheet>

      {isAdmin ? (
        <>
          <SectionTitle>Managers ({cls.managerUids.length})</SectionTitle>
          <Card>
            {/* Managers are scoped-DOWN staff — access to just this course.
                Admins already have every course, so listing them here (or the
                admin themselves) only invites a pointless, confusing self-toggle;
                exclude them. */}
            <Text style={styles.managerLede}>
              Managers get access to just this course. You — and other admins —
              already have access to every course.
            </Text>
            {assignableManagers.length === 0 ? (
              <Empty>
                No managers to assign yet. Staff who sign in with Google appear here once you
                approve them as a manager, then you can give them this course.
              </Empty>
            ) : (
              assignableManagers.map((s) => {
                  const on = cls.managerUids.includes(s.uid);
                  const pending = managerWriteInFlight && managerBusy?.uid === s.uid;
                  return (
                    <Pressable
                      key={s.uid}
                      testID={`course-manager-${s.email}`}
                      accessibilityRole="checkbox"
                      // aria-*, not accessibilityState: react-native-web has no
                      // mapping for accessibilityState, so it reaches the DOM as
                      // nothing at all and the checkbox exposes no checked state
                      // to assistive tech. RN supports the aria props natively.
                      aria-checked={on}
                      aria-disabled={managerWriteInFlight}
                      accessibilityLabel={`${on ? 'Remove' : 'Assign'} ${s.displayName}`}
                      // Locked while ANY manager write is in flight: this sends the
                      // whole array, so a second tap computed from the pre-write
                      // list would silently undo the first.
                      disabled={managerWriteInFlight}
                      onPress={() =>
                        void runManager(s.uid, !on, () =>
                          setCourseManagers({
                            courseId: cls.id,
                            managerUids: on
                              ? cls.managerUids.filter((u) => u !== s.uid)
                              : [...cls.managerUids, s.uid],
                          }),
                        )
                      }
                      style={[
                        styles.pickRow,
                        managerWriteInFlight && !pending ? styles.rowWaiting : null,
                      ]}
                    >
                      {pending ? (
                        <ActivityIndicator style={styles.tick} color={t.accent.base} />
                      ) : (
                        /* A TICK, not just a fill. A bare filled square is the
                           app's only checkbox and its checked state was colour
                           alone, which reads as an image that failed to load —
                           and says nothing at all to a screen reader's user who
                           is also colour-blind. */
                        <View style={[styles.tick, on ? styles.tickOn : null]}>
                          {on ? <Text style={styles.tickMark}>✓</Text> : null}
                        </View>
                      )}
                      <View style={styles.pickText}>
                        <Text style={styles.name}>{s.displayName}</Text>
                        <EmailText email={s.email} />
                      </View>
                    </Pressable>
                  );
                })
            )}
          </Card>

          <SectionTitle>Settings</SectionTitle>
          <Card>
            <SwitchRow
              testID="course-archived-access"
              label="Keep recordings open when archived"
              description="Students can still play the recordings they were given."
              on={cls.archivedAccess}
              onChange={(next) =>
                void run('access', () => updateCourse({ courseId: cls.id, archivedAccess: next }))
              }
            />
            <Button
              testID="course-archive"
              label={cls.archived ? 'Reactivate course' : 'Archive course'}
              variant="secondary"
              busy={busy === 'archive'}
              onPress={() =>
                void run('archive', () => updateCourse({ courseId: cls.id, archived: !cls.archived }))
              }
            />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

/**
 * The course's assignments at a glance, under its row: what is posted, what
 * waits on the teacher, and what waits on students. Nothing until the figures
 * arrive — four zeros would be an answer.
 */
function AssignmentsCounts({ cls }: { cls: CourseRow }) {
  const coursework = useCourseCourseworkState(cls.id);
  const figures = useCourseworkFigures(cls);
  if (coursework === null || figures === null) return null;
  const posted = coursework.filter((c) => c.status === 'posted');
  const sum = (k: 'toGrade' | 'pastDue' | 'missed') => posted.reduce((n, c) => n + figures(c)[k], 0);
  return (
    <CountsLine
      testID="course-assignments-line"
      counts={[
        { value: posted.length, label: 'posted' },
        { value: sum('toGrade'), label: 'to grade' },
        { value: sum('pastDue'), label: 'past due' },
        { value: sum('missed'), label: 'missed', alarm: true },
      ]}
    />
  );
}

/** The in-place confirm that stands where a roster row was. */
function ConfirmRow({ children }: { children: ReactNode }) {
  return <View style={[styles.confirmRow, useGridCell()]}>{children}</View>;
}

const styles = StyleSheet.create({
  name: { fontSize: 15, fontWeight: '600', color: t.text.primary },
  hint: { fontSize: 13, color: t.text.secondary },
  managerLede: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2), lineHeight: 19 },
  pickRowBusy: { opacity: 0.6 },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing(2),
    gap: spacing(3),
  },
  pickText: { flex: 1, minWidth: 0 },
  rowWaiting: { opacity: 0.5 },
  // Sits where the row was, so the list does not jump while confirming.
  confirmRow: {
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    paddingHorizontal: spacing(4),
    paddingBottom: spacing(3),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  // A tappable list, not a dropdown: React Native has no dropdown primitive, and
  // the same shape is already used for approve-as-manager/-admin.
  tick: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: t.border.strong,
    backgroundColor: t.bg.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
  tickMark: { fontSize: 14, fontWeight: '700', color: t.accent.onAccent, lineHeight: 16 },
  plus: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: t.bg.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: { fontSize: 15, fontWeight: '700', color: t.text.primary, lineHeight: 18 },
});
