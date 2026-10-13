import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  AddAction,
  Button,
  Card,
  Collapsible,
  Empty,
  Field,
  Grid,
  Notice,
  Screen,
  SectionTitle,
  StatusChip,
  useAddAction,
} from '../components/ui';
import {
  createCourse,
  renameCohort,
  setCohortArchived,
  useCohortState,
  useCoursesInCohortState,
  type CohortRow,
  type CourseRow,
} from '../structure';
import { getTheme, spacing } from '../theme';

const NO_COURSES: CourseRow[] = [];
import { errorText } from '../errors';

const t = getTheme();

/** The create form, in the sheet the header action opens. */
function AddCourse({ cohortId }: { cohortId: string }) {
  const close = useAddAction();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Field
        testID="course-name"
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        placeholder="Hikam Foundations"
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        testID="course-create"
        label="Create course"
        busy={busy}
        disabled={!name.trim()}
        block
        onPress={() => {
          setBusy(true);
          setError(null);
          void createCourse({ cohortId, name: name.trim() })
            .then(() => {
              setName('');
              close();
            })
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}

/** Shared with the cohort list, which shows the same count per cohort. */
export function courseLabel(n: number): string {
  return n === 1 ? '1 course' : `${n} courses`;
}

/**
 * Admin-only: one cohort — its settings and the courses inside it.
 *
 * This IS the cohort's page, which is why archiving lives here and not on the
 * list, mirroring a course. The cohort is read LIVE rather than taken from the
 * navigation param: this screen now edits the cohort it displays, and a control
 * that renders and computes its next value from a frozen copy never appears to
 * work (see useCohort).
 */
export function CoursesScreen({
  cohortId,
  onOpen,
}: {
  cohortId: string;
  onOpen: (cls: CourseRow) => void;
}) {
  const cohortState = useCohortState(cohortId);
  const cohort = cohortState.value;
  const coursesState = useCoursesInCohortState(cohortId);
  const courses = coursesState ?? NO_COURSES;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archived = cohort?.archived ?? false;
  /*
   * Archived courses at the bottom, closed — finished classes are history,
   * and interleaved with the running ones they were most of the page. In an
   * archived cohort EVERY course is inactive and the notice above says why,
   * so there the list stays whole rather than folding everything away.
   */
  const current = archived ? courses : courses.filter((c) => c.effectiveActive);
  const past = archived ? [] : courses.filter((c) => !c.effectiveActive);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // A URL can name a cohort that does not exist. Say so rather than rendering a
  // settings card and an add-a-course form for nothing — the server would
  // refuse the create anyway ("No such cohort"), but only after the typing.
  if (!cohort) {
    return (
      <Screen>
        <Empty>
          {cohortState.resolved
            ? 'That cohort is not available. It may have been removed.'
            : 'Loading…'}
        </Empty>
      </Screen>
    );
  }

  return (
    <Screen
      title={cohort.name}
      subtitle="Courses in this cohort"
      status={archived ? 'archived' : 'active'}
      width="list"
      actions={
        <AddAction testID="courses-add" label="Add a course" title="Add a course">
          <AddCourse cohortId={cohortId} />
        </AddAction>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {archived ? (
        <Notice tone="info">
          This cohort is archived, so every course in it is inactive regardless of its own
          setting. Reactivating the cohort restores each course to the state it was in.
        </Notice>
      ) : null}

      <SectionTitle>Settings</SectionTitle>
      <Card>
        <CohortName cohort={cohort} busy={busy === 'rename'} run={run} />
        {/* State the blast radius rather than gating it behind a confirm:
            archiving is the SAFE action in this product, and obstructing the
            safe action is how people learn to click through warnings. */}
        {/* Only on the way IN: the notice above already explains the archived
            state, and saying it twice reads as a stutter. */}
        {/* The blast radius only when there IS one — "also turns off 0 courses"
            is a sentence about an empty set, which is the state a cohort spends
            its first week in. The reassurance is not conditional on that: it is
            true of archiving whatever the cohort holds, and taking it away with
            the count left a bare Archive button with nothing to say it can be
            undone. */}
        {archived ? null : (
          <Text style={styles.hint}>
            {courses.length === 0
              ? 'Archiving is reversible.'
              : `Archiving also turns off ${courseLabel(courses.length)} in this cohort. It is reversible.`}
          </Text>
        )}
        <Button
          testID="cohort-archive"
          label={archived ? 'Reactivate cohort' : 'Archive cohort'}
          variant="secondary"
          busy={busy === 'archive'}
          onPress={() =>
            void run('archive', () => setCohortArchived({ cohortId, archived: !archived }))
          }
        />
      </Card>

      <SectionTitle>Courses{coursesState === null ? '' : ` (${current.length})`}</SectionTitle>
      {coursesState === null ? (
        <Empty>Checking…</Empty>
      ) : courses.length === 0 ? (
        <Empty>No courses in this cohort yet.</Empty>
      ) : current.length === 0 ? (
        <Empty>Every course in this cohort is archived.</Empty>
      ) : (
        <Grid min={320}>
          {current.map((c) => (
            <CourseCard key={c.id} cls={c} onOpen={onOpen} />
          ))}
        </Grid>
      )}
      {past.length > 0 ? (
        <Collapsible testID="courses-archived" title="Archived" count={past.length}>
          <Grid min={320}>
            {past.map((c) => (
              <CourseCard key={c.id} cls={c} onOpen={onOpen} />
            ))}
          </Grid>
        </Collapsible>
      ) : null}
    </Screen>
  );
}

/**
 * The cohort's name, editable — the same field-and-Rename shape a course's
 * settings card has, so the two pages read as one design.
 *
 * Its own component because the draft has to be SEEDED from the cohort once,
 * and the screen renders the cohort live: seeding in the screen's own state
 * would either race the first snapshot (an empty field) or need an effect that
 * overwrites what is being typed every time the document changes. Mounted only
 * once the cohort has resolved, the initial state is simply its name.
 */
function CohortName({
  cohort,
  busy,
  run,
}: {
  cohort: CohortRow;
  busy: boolean;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [name, setName] = useState(cohort.name);
  const trimmed = name.trim();
  return (
    <>
      <Field testID="cohort-rename" label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
      <Button
        testID="cohort-rename-save"
        label="Rename"
        // Nothing to save until the name differs — a Rename that writes the
        // same name again is a button that does nothing.
        disabled={!trimmed || trimmed === cohort.name}
        busy={busy}
        onPress={() => void run('rename', () => renameCohort({ cohortId: cohort.id, name: trimmed }))}
      />
    </>
  );
}

export function CourseCard({ cls, onOpen }: { cls: CourseRow; onOpen: (c: CourseRow) => void }) {
  return (
    <Card>
      <Pressable
        testID={`course-open-${cls.name}`}
        accessibilityRole="button"
        accessibilityLabel={`Open ${cls.name}`}
        onPress={() => onOpen(cls)}
      >
        <Text style={styles.name}>{cls.name}</Text>
        <View style={styles.meta}>
          <StatusChip status={cls.effectiveActive ? 'active' : 'inactive'} />
          {!cls.effectiveActive && cls.archivedAccess ? (
            <Text style={styles.hint}>recordings still open</Text>
          ) : null}
          {/* "0 managers" is a count of nothing; the course needs one, so say
              so. */}
          <Text style={styles.hint}>
            {cls.managerUids.length === 0
              ? 'No manager yet'
              : cls.managerUids.length === 1
                ? '1 manager'
                : `${cls.managerUids.length} managers`}
          </Text>
        </View>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing(3),
    marginTop: spacing(2),
  },
  hint: { fontSize: 13, color: t.text.secondary },
});
