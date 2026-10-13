import { useState } from 'react';
import {
  AddAction,
  Button,
  Collapsible,
  Empty,
  Field,
  Grid,
  ListRow,
  Notice,
  Screen,
  SectionTitle,
  useAddAction,
} from '../components/ui';
import { createCohort, useAllCourses, useCohortsState, type CohortRow } from '../structure';

const NO_COHORTS: CohortRow[] = [];
import { courseLabel } from './CoursesScreen';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';

/**
 * Admin-only: the list of cohorts.
 *
 * No archive control here, matching courses: a cohort's settings live inside the
 * cohort, so the list stays a list. Archived cohorts are kept out of the way in
 * a closed section rather than interleaved — a finished term is history, and at
 * three or four terms it was most of the screen.
 */
export function CohortsScreen({ onOpen }: { onOpen: (cohort: CohortRow) => void }) {
  const cohortsState = useCohortsState(true);
  const cohorts = cohortsState ?? NO_COHORTS;
  // Courses across all cohorts, counted per cohort so each card shows its size
  // without a tap. Admin-only screen, so the all-courses list is readable.
  const courses = useAllCourses(true);
  const courseCounts = courses.reduce<Record<string, number>>((acc, c) => {
    acc[c.cohortId] = (acc[c.cohortId] ?? 0) + 1;
    return acc;
  }, {});
  const active = cohorts.filter((c) => !c.archived);
  const archived = cohorts.filter((c) => c.archived);

  return (
    <Screen
      /* NAMED FOR THE TAB THAT LEADS HERE. It is a list of cohorts, but the way
         in is called Courses, and a destination whose heading contradicts the
         control that opened it reads as a wrong turn. The subtitle carries what
         a cohort is. */
      title="Courses"
      subtitle="By cohort — a semester, and the courses inside it"
      width="list"
      actions={
        <AddAction testID="cohorts-add" label="Add a cohort" title="Add a cohort">
          <AddCohort />
        </AddAction>
      }
    >
      <SectionTitle>Cohorts{cohortsState === null ? '' : ` (${active.length})`}</SectionTitle>
      {cohortsState === null ? (
        <Empty>Checking…</Empty>
      ) : active.length === 0 ? (
        <Empty>No cohorts yet.</Empty>
      ) : (
        <Grid min={320}>
          {active.map((c) => (
            <CohortRowItem key={c.id} cohort={c} count={courseCounts[c.id] ?? 0} onOpen={onOpen} />
          ))}
        </Grid>
      )}

      {archived.length > 0 ? (
        <Collapsible testID="cohorts-archived" title="Archived" count={archived.length}>
          <Grid min={320}>
            {archived.map((c) => (
              <CohortRowItem key={c.id} cohort={c} count={courseCounts[c.id] ?? 0} onOpen={onOpen} />
            ))}
          </Grid>
        </Collapsible>
      ) : null}
    </Screen>
  );
}

/** The create form, in the sheet the header action opens. */
function AddCohort() {
  const close = useAddAction();
  const [name, setName] = useState('');
  const { active, run } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Field
        testID="cohort-name"
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        placeholder="Autumn 2026"
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        testID="cohort-create"
        label="Create cohort"
        busy={active !== null}
        disabled={!name.trim()}
        block
        onPress={() =>
          void run('create', async () => {
            setError(null);
            try {
              await createCohort({ name: name.trim() });
              setName('');
              close();
            } catch (e) {
              setError(errorText(e));
            }
          })
        }
      />
    </>
  );
}

function CohortRowItem({
  cohort,
  count,
  onOpen,
}: {
  cohort: CohortRow;
  count: number;
  onOpen: (cohort: CohortRow) => void;
}) {
  return (
    // No status chip: which section a cohort is in already says whether it is
    // archived, and repeating it on every row is the clutter this screen was
    // reorganised to remove.
    <ListRow
      testID={`cohort-open-${cohort.name}`}
      name={cohort.name}
      detail={courseLabel(count)}
      onPress={() => onOpen(cohort)}
    />
  );
}

