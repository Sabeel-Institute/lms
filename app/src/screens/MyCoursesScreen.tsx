import { Collapsible, Empty, Grid, Notice, Screen } from '../components/ui';
import { useListenerFailed } from '../liveQuery';
import { useMyCoursesState, type CourseRow } from '../structure';
import { CourseCard } from './CoursesScreen';

/**
 * A manager's own courses.
 *
 * This is the query the manager arm of the courses rule exists to serve: it
 * carries `array-contains` on managerUids, which is what Firestore requires
 * before it will run a list whose rule depends on document data.
 */
export function MyCoursesScreen({
  uid,
  onOpen,
}: {
  uid: string;
  onOpen: (cls: CourseRow) => void;
}) {
  /*
   * THE `State` VARIANT, so "none have arrived" is not rendered as "there are
   * none". The `?? []` wrapper reads identically on a cold load and on an
   * unassigned account — and this screen answers the second with "You are not
   * assigned to any courses yet" and a notice about waiting for an
   * administrator. Shown to a manager whose access
   * was granted an hour ago, for the length of every load, that reads as their
   * access being broken.
   */
  const loaded = useMyCoursesState(uid);
  const courses = loaded ?? [];
  // A REFUSAL IS NOT A LOAD. `useLiveQuery` resets to `empty` on a listener
  // error as well as before the first snapshot, so without this a denial would
  // sit on "Checking your courses…" for ever — the trap `today.ts` documents.
  // `Screen` shows the error banner itself; this only has to stop claiming to
  // still be looking.
  const failed = useListenerFailed(['myCourses']);
  const checking = loaded === null && !failed;
  // Archived courses at the bottom, closed, as on a cohort's page.
  const current = courses.filter((c) => c.effectiveActive);
  const past = courses.filter((c) => !c.effectiveActive);
  return (
    <Screen title="Your courses" width="list">
      {checking ? (
        <Empty>Checking your courses…</Empty>
      ) : loaded === null ? (
        <Empty>Your courses could not be read. The message above says why.</Empty>
      ) : courses.length === 0 ? (
        <>
          <Empty>You are not assigned to any courses yet.</Empty>
          <Notice tone="info">
            An administrator assigns courses. Once assigned, you can manage that course&apos;s
            roster here.
          </Notice>
        </>
      ) : current.length === 0 ? (
        <Empty>All your courses are archived.</Empty>
      ) : (
        <Grid min={330}>
          {current.map((c) => (
            <CourseCard key={c.id} cls={c} onOpen={onOpen} />
          ))}
        </Grid>
      )}
      {past.length > 0 ? (
        <Collapsible testID="courses-archived" title="Archived" count={past.length}>
          <Grid min={330} rows>
            {past.map((c) => (
              <CourseCard key={c.id} cls={c} onOpen={onOpen} />
            ))}
          </Grid>
        </Collapsible>
      ) : null}
    </Screen>
  );
}
