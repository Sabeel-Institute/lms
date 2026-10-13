import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { hasLedger, isVisibleToStudents, startingItem, type RecordingStatus } from '@sabeel/shared';
import {
  Button,
  Card,
  Chips,
  Empty,
  Grid,
  Row,
  Screen,
  SectionTitle,
  StatusChip,
  statusWord,
} from '../components/ui';
import { Select } from '../components/Select';
import { useAllRecordingsState, useCourseRecordingsState, type RecordingRow } from '../recordings';
import { useListenerFailed } from '../liveQuery';
import {
  useAllCoursesState,
  useCohortName,
  useCohorts,
  useMyCoursesState,
  type CourseRow,
} from '../structure';
import {
  WHOLE_LIBRARY,
  cohortOptions,
  courseOptions,
  inScope,
  isNarrowed,
  pickCohort,
  type LibraryScope,
} from '../libraryFilters';
import { getTheme, spacing } from '../theme';

const t = getTheme();
// One empty list, not a fresh `[]` per render: the lists below feed memos.
const NO_COURSES: CourseRow[] = [];
const NO_RECORDINGS: RecordingRow[] = [];
type StatusFilter = 'all' | RecordingStatus;
/**
 * The filter, and the words a person reads on it.
 *
 * THE LABELS COME FROM `statusWord`, not from a second map beside this one. A
 * recording's status is written in two places on this screen — the filter and
 * the chip on every card — and they were two independent spellings of the same
 * six values, each carrying its own `needsAttention: 'needs attention'`. Lower
 * case throughout, because that is how `StatusChip` renders the same words.
 */
const STATUSES: { value: StatusFilter; label: string }[] = (
  ['all', 'published', 'draft', 'archived', 'unpublished', 'needsAttention'] as StatusFilter[]
).map((value) => ({ value, label: statusWord(value) }));

/**
 * The cross-cohort recording library with status counts (deferred from Phase 3).
 * Admin sees a flat list of everything; a manager sees a section per course they
 * run (the rules forbid an unconstrained recordings list to a manager).
 */
export function LibraryScreen({
  uid,
  isAdmin,
  onPlay,
  onOpenProgress,
}: {
  uid: string;
  isAdmin: boolean;
  onPlay: (recording: RecordingRow, cls: CourseRow) => void;
  onOpenProgress: (recording: RecordingRow, cls: CourseRow) => void;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [scope, setScope] = useState<LibraryScope>(WHOLE_LIBRARY);
  // The `State` variant: before the first snapshot "you are not assigned to any
  // courses" is not the answer, it is the absence of one — and it reads to a
  // manager as their access having been revoked.
  const myCoursesLoaded = useMyCoursesState(isAdmin ? null : uid);
  const myCourses = myCoursesLoaded ?? NO_COURSES;
  // A refusal is not a load — see `MyCoursesScreen`.
  const myCoursesFailed = useListenerFailed(['myCourses']);
  // Real course rows so the admin's flat list can show which course each
  // recording is in, and the ledger it opens shows the course NAME — not the
  // raw id (which is what a placeholder `{ name: courseId }` row leaked into
  // the ledger subtitle). Held here rather than in `AdminLibrary` because the
  // course dropdown is built from the same rows.
  const allCourses = useAllCoursesState(isAdmin);
  // A course name alone is ambiguous across cohorts; this library spans them.
  const cohortNameOf = useCohortName();
  const cohorts = useCohorts(true);

  /*
   * THE SAME TWO DROPDOWNS FOR BOTH ROLES, built from the courses each can see.
   * A manager's cohort list is therefore the cohorts their own courses are in,
   * and nothing else — every other cohort would filter to an empty page.
   */
  const courses = isAdmin ? (allCourses ?? NO_COURSES) : myCourses;
  // A manager's sections, narrowed. The dropdowns only ever offer courses they
  // run, so this is normally non-empty — but a course can be taken off them
  // while it is chosen, and then the page has to say so itself, because there
  // is no section left to say it.
  const mySections = useMemo(
    () => myCourses.filter((cls) => inScope({ cohortId: cls.cohortId, courseId: cls.id }, scope)),
    [myCourses, scope],
  );
  const cohortChoices = useMemo(() => cohortOptions(cohorts, courses), [cohorts, courses]);
  const courseChoices = useMemo(
    () => courseOptions(courses, scope.cohortId, cohortNameOf),
    [courses, scope.cohortId, cohortNameOf],
  );
  const narrowed = isNarrowed(status, scope);
  const clear = () => {
    setStatus('all');
    setScope(WHOLE_LIBRARY);
  };

  return (
    <Screen
      title="Recording library"
      subtitle={isAdmin ? 'Every recording, across every cohort' : 'Recordings in the courses you run'}
      width="list"
    >
      <View style={styles.filter}>
        <Chips value={status} testIdPrefix="library-filter" options={STATUSES} onChange={setStatus} />
        {/* Cohort first, then course: the cohort narrows what the course
            dropdown offers, never the other way round (`libraryFilters`). */}
        <View style={styles.scope}>
          <Select
            testID="library-cohort"
            label="Cohort"
            value={scope.cohortId}
            options={cohortChoices}
            onChange={(cohortId) => setScope((s) => pickCohort(s, cohortId, courses))}
          />
          <Select
            testID="library-course"
            label="Course"
            value={scope.courseId}
            options={courseChoices}
            onChange={(courseId) => setScope((s) => ({ ...s, courseId }))}
          />
          {/* Only ever present when there is something to clear, so it is
              never a dead control. Quiet: it undoes, it does not act. */}
          {narrowed ? (
            <Button testID="library-clear" label="Clear filters" variant="quiet" hug onPress={clear} />
          ) : null}
        </View>
      </View>

      {isAdmin ? (
        <AdminLibrary
          status={status}
          scope={scope}
          courses={allCourses}
          cohortNameOf={cohortNameOf}
          onPlay={onPlay}
          onOpenProgress={onOpenProgress}
        />
      ) : myCoursesLoaded === null ? (
        <Empty>
          {myCoursesFailed
            ? 'Your courses could not be read. The message above says why.'
            : 'Checking your courses…'}
        </Empty>
      ) : myCourses.length === 0 ? (
        <Empty>You are not assigned to any courses.</Empty>
      ) : mySections.length === 0 ? (
        <Empty>No recordings match these filters.</Empty>
      ) : (
        mySections.map((cls) => (
          <CourseSection
            key={cls.id}
            cls={cls}
            cohortName={cohortNameOf(cls.cohortId)}
            status={status}
            onPlay={onPlay}
            onOpenProgress={onOpenProgress}
          />
        ))
      )}
    </Screen>
  );
}

function AdminLibrary({
  status,
  scope,
  courses,
  cohortNameOf,
  onPlay,
  onOpenProgress,
}: {
  status: StatusFilter;
  scope: LibraryScope;
  /** `null` until the course list has arrived — see the note on the wait below. */
  courses: CourseRow[] | null;
  cohortNameOf: (cohortId: string) => string;
  onPlay: (r: RecordingRow, c: CourseRow) => void;
  onOpenProgress: (r: RecordingRow, c: CourseRow) => void;
}) {
  // `null` until the recordings listener answers — so "No recordings match"
  // waits for both halves, the courses and the recordings.
  const allState = useAllRecordingsState(true);
  const all = allState ?? NO_RECORDINGS;
  const coursesFailed = useListenerFailed(['allCourses']);
  const courseById = useMemo(() => new Map((courses ?? []).map((c) => [c.id, c])), [courses]);
  // The cohort and course scope first, then the status within it — so the
  // counts line describes the term or course being looked at, and the status
  // pills break THAT down rather than the whole institute.
  const scoped = useMemo(() => all.filter((r) => inScope(r, scope)), [all, scope]);
  const filtered = useMemo(
    () => (status === 'all' ? scoped : scoped.filter((r) => r.status === status)),
    [scoped, status],
  );
  const clsFor = (r: RecordingRow): CourseRow =>
    courseById.get(r.courseId) ??
    // Fallback for a recording whose course was deleted: still openable, and the
    // id at least tells you which course is missing.
    ({ id: r.courseId, name: r.courseId, cohortId: r.cohortId } as CourseRow);
  return (
    <>
      <Counts recordings={scoped} />
      {/* THE COURSES, NOT THE RECORDINGS, ARE WHAT THIS WAITS FOR. Every row
          names its course, and `clsFor`'s fallback — meant for a recording
          whose course was deleted — otherwise fires for EVERY row on a cold
          load, printing a raw Firestore id where the course name goes and
          carrying it into the ledger this list opens. */}
      {courses === null || allState === null ? (
        <Empty>{coursesFailed ? 'The library could not be read.' : 'Loading the library…'}</Empty>
      ) : filtered.length === 0 ? (
        <Empty>No recordings match these filters.</Empty>
      ) : (
        <Grid min={330}>
          {filtered.map((r) => {
            const cls = clsFor(r);
            return (
              <RecordingLine
                key={r.id}
                r={r}
                courseName={cls.name}
                cohortName={cohortNameOf(cls.cohortId)}
                onPlay={() => onPlay(r, cls)}
                onOpenProgress={() => onOpenProgress(r, cls)}
              />
            );
          })}
        </Grid>
      )}
    </>
  );
}

function CourseSection({
  cls,
  cohortName,
  status,
  onPlay,
  onOpenProgress,
}: {
  cls: CourseRow;
  cohortName: string;
  status: StatusFilter;
  onPlay: (r: RecordingRow, c: CourseRow) => void;
  onOpenProgress: (r: RecordingRow, c: CourseRow) => void;
}) {
  const recordingsState = useCourseRecordingsState(cls.id);
  const recordings = recordingsState ?? NO_RECORDINGS;
  const filtered = status === 'all' ? recordings : recordings.filter((r) => r.status === status);
  return (
    <>
      <SectionTitle>{cohortName ? `${cls.name} · ${cohortName}` : cls.name}</SectionTitle>
      {recordingsState === null ? null : <Counts recordings={recordings} />}
      {recordingsState === null ? (
        <Empty>Loading…</Empty>
      ) : filtered.length === 0 ? (
        <Empty>No recordings match these filters.</Empty>
      ) : (
        <Grid min={330}>
          {filtered.map((r) => (
            <RecordingLine
              key={r.id}
              r={r}
              onPlay={() => onPlay(r, cls)}
              onOpenProgress={() => onOpenProgress(r, cls)}
            />
          ))}
        </Grid>
      )}
    </>
  );
}

function Counts({ recordings }: { recordings: RecordingRow[] }) {
  const published = recordings.filter((r) => isVisibleToStudents(r.status)).length;
  const attention = recordings.filter((r) => r.status === 'needsAttention').length;
  return (
    <Text style={styles.counts}>
      {recordings.length} total · {published} published
      {attention > 0 ? ` · ${attention} ${attention === 1 ? 'needs' : 'need'} attention` : ''}
    </Text>
  );
}

function RecordingLine({
  r,
  courseName,
  cohortName,
  onPlay,
  onOpenProgress,
}: {
  r: RecordingRow;
  courseName?: string;
  cohortName?: string;
  onPlay: () => void;
  onOpenProgress: () => void;
}) {
  const playable = startingItem(r.media, r.defaultVersion) !== null;
  return (
    <Card>
      <Text style={styles.title}>{r.title}</Text>
      {/* Admin flat list shows the course AND its cohort — a course name alone is
          ambiguous across cohorts. The manager view groups by course, so it
          passes no courseName. */}
      {courseName ? (
        <Text style={styles.courseName}>
          {cohortName ? `${courseName} · ${cohortName}` : courseName}
        </Text>
      ) : null}
      <View style={styles.meta}>
        <StatusChip status={r.status} />
        <Text style={styles.sub}>
          {r.durationSec ? `${Math.round(r.durationSec / 60)} min` : playable ? 'length unknown' : 'no audio'}
          {r.date ? ` · ${r.date}` : ''}
        </Text>
      </View>
      {/* Pushed to the foot of the card: the cards in a row are the same height,
          and a title that wraps used to drop its own actions below its
          neighbours' — level outlines with a ragged row of buttons inside. NOT
          RENDERED WHEN THERE IS NOTHING IN IT, because the same `marginTop:
          'auto'` made an empty row reserve 76px of blank card under a recording
          with no audio, half the height of the card beside it. */}
      {playable || hasLedger(r) ? (
        <View style={styles.actions}>
          <Row>
            {/* PRIMARY, and the only one on the card. Two identical sage bars
                six times down a page gave the library no answer to "what do I do
                here", and listening is what the library is for — the ledger
                beside it is the follow-up. */}
            {playable ? (
              <Button testID={`library-listen-${r.title}`} label="Listen" onPress={onPlay} />
            ) : null}
            {hasLedger(r) ? (
              <Button
                testID={`library-progress-${r.title}`}
                label="Listening progress"
                variant="secondary"
                onPress={onOpenProgress}
              />
            ) : null}
          </Row>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: 'auto' },
  filter: { marginBottom: spacing(4) },
  // Wraps, like the pills above it: two dropdowns and a clear control are one
  // line on a laptop and two on a 320px phone.
  scope: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing(2),
    marginTop: spacing(3),
  },
  counts: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2) },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  courseName: { fontSize: 13, color: t.text.secondary, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), marginTop: spacing(2) },
  sub: { fontSize: 13, color: t.text.secondary },
});
