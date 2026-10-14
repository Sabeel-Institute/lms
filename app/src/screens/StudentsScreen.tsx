import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  AddAction,
  Button,
  Collapsible,
  EmailText,
  Empty,
  Field,
  Grid,
  ListRow,
  Notice,
  Screen,
  SectionTitle,
  useAddAction,
} from '../components/ui';
import { createStudent, useStudentsState, type StudentRow } from '../students';

const NO_STUDENTS: StudentRow[] = [];
import { useAllCourses, useCohorts, useMyCourses } from '../structure';
import { CAN_CREATE_ACCOUNTS } from '../accountCreation';
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';

const t = getTheme();

/**
 * Staff: create students and manage their access.
 *
 * Creating a student IS the approval — they arrive active, with no pending
 * state. The account is made without a password and the student sets their own
 * from an emailed link; completing that link is what proves they control the
 * address, so there is no separate verification step.
 *
 * Enrolment into a course is added in 1b, once courses exist.
 */
export function StudentsScreen({
  isAdmin,
  uid,
  header,
  onOpenStudent,
}: {
  isAdmin: boolean;
  uid: string;
  /** Rendered directly under the heading — the People tab's students/staff
   *  switch. Passed in rather than owned here so this screen stays one list. */
  header?: ReactNode;
  onOpenStudent: (studentUid: string) => void;
}) {
  const studentsState = useStudentsState(true);
  const students = studentsState ?? NO_STUDENTS;
  const active = students.filter((s) => s.status === 'active');
  const disabled = students.filter((s) => s.status === 'disabled');
  const deleted = students.filter((s) => s.status === 'deleted');
  /*
   * THE CONFIRMATION BELONGS HERE, not inside the sheet that created the account.
   *
   * Every other create sheet closes on success and the new row appearing in the
   * list behind it IS the confirmation. This one has something more to say — a
   * set-password link has been emailed, and nobody handled a password — and the
   * list cannot say it. Closing the sheet with the message still in it meant the
   * message was never read.
   */
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Screen
      title="People"
      subtitle="Students and their access"
      width="list"
      /* CREATION IS WEB-ONLY — see `accountCreation.ts`. The button is absent on
         the apps, with nothing in its place: a line explaining where to do it
         instead would itself be the thing the store rule forbids. Everything
         else on this screen — access, enrolment, the student's own page —
         stays, because none of it creates an identity. */
      actions={
        CAN_CREATE_ACCOUNTS ? (
          <AddAction testID="students-add" label="Add a student" title="Add a student">
            <AddStudent isAdmin={isAdmin} uid={uid} onCreated={setCreated} />
          </AddAction>
        ) : null
      }
    >
      {header}
      {created ? <Notice tone="success">{created}</Notice> : null}

      {/* The list is for finding someone; everything you can DO to them lives on
          their page. Per-row actions made every row three controls wide and
          still answered nothing about the student. */}
      <SectionTitle>Students{studentsState === null ? '' : ` (${active.length})`}</SectionTitle>
      {studentsState === null ? (
        <Empty>Checking…</Empty>
      ) : active.length === 0 ? (
        <Empty>No students yet.</Empty>
      ) : (
        <Grid min={330} rows>
          {active.map((s) => (
            <ListRow
              key={s.uid}
              testID={`student-open-${s.email ?? s.uid}`}
              name={s.displayName}
              detail={<EmailText email={s.email} />}
              onPress={() => onOpenStudent(s.uid)}
            />
          ))}
        </Grid>
      )}

      {disabled.length > 0 ? (
        <Collapsible testID="students-disabled" title="Disabled" count={disabled.length}>
          {/* No status chip: the section says it. */}
          <Grid min={330} rows>
            {disabled.map((s) => (
              <ListRow
                key={s.uid}
                testID={`student-open-${s.email ?? s.uid}`}
                name={s.displayName}
                detail={<EmailText email={s.email} />}
                onPress={() => onOpenStudent(s.uid)}
              />
            ))}
          </Grid>
        </Collapsible>
      ) : null}

      {/* Their record is still theirs to open: the account went, the
          attendance, listening, work and grades did not. */}
      {deleted.length > 0 ? (
        <Collapsible testID="students-deleted" title="Deleted" count={deleted.length}>
          <Grid min={330} rows>
            {deleted.map((s) => (
              <ListRow key={s.uid} testID={`student-open-${s.uid}`} name={s.displayName} onPress={() => onOpenStudent(s.uid)} />
            ))}
          </Grid>
        </Collapsible>
      ) : null}
    </Screen>
  );
}

interface CourseOption {
  id: string;
  name: string;
  cohortName: string;
}

/**
 * The courses this staff member may enrol into.
 *
 * An admin sees every ACTIVE course in every cohort (not just the latest — a
 * course in an older semester was invisible before, and two courses that share
 * a name across semesters looked like one). A manager sees only their own —
 * which is also all the security rules would let them read. Each option carries
 * its cohort name so same-named courses are distinguishable. Both roles may
 * read cohorts.
 *
 * ARCHIVED COURSES ARE NOT OFFERED. A new student is being enrolled into
 * something that is running, and by the third term the archived courses
 * outnumbered the live ones in this list — "Hikam Foundations" three times
 * over, two of them finished. `effectiveActive` is the test, so a course
 * switched off by its cohort's archiving goes too. Enrolling into an archived
 * course is still possible, deliberately, from the course's own page.
 */

/**
 * The create form, in the sheet the header action opens.
 *
 * REACHED ONLY ON WEB (`CAN_CREATE_ACCOUNTS`). The component is still compiled
 * into the app bundle, which is fine — what the store rules turn on is whether
 * a user can reach a creation flow, and with no affordance there is no route to
 * this at all.
 */
function AddStudent({
  isAdmin,
  uid,
  onCreated,
}: {
  isAdmin: boolean;
  uid: string;
  /** Reports the success line to the screen, which is where it can be read. */
  onCreated: (message: string) => void;
}) {
  const close = useAddAction();
  const courseOptions = useCourseOptions(isAdmin, uid);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null);
  const { active, run } = useOneAtATime();
  const busy = active !== null;
  const [error, setError] = useState<string | null>(null);

  // One at a time: a double tap created the account and then showed the
  // second call's "already exists" over an account that was made.
  const create = () =>
    run('create', async () => {
      setError(null);
      try {
        const address = email.trim();
        // READ `emailSent`. The account and the email are two outcomes, not one:
        // `createStudent` keeps the account when the send fails so staff can
        // resend, and reporting a link that never went leaves someone waiting for
        // an email that is not coming — with an account nobody can sign in to.
        const { emailSent } = await createStudent({
          displayName: displayName.trim(),
          email: address.toLowerCase(),
          courseId: courseId ?? undefined,
        });
        onCreated(
          emailSent
            ? `Account created. A set-password link has been emailed to ${address}.`
            : `Account created, but the set-password link could not be emailed to ${address}. Open their page and use Resend password link.`,
        );
        setDisplayName('');
        setEmail('');
        setCourseId(null);
        close();
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <>
      <Field
        testID="student-name"
        label="Full name"
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
        placeholder="Fatima Ahmed"
      />
      <Field
        testID="student-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        placeholder="student@example.com"
      />
      {courseOptions.length > 0 ? (
        <View style={styles.picker}>
          {/* A tappable list, not a dropdown — React Native has no dropdown
              primitive, and this matches the approve-as-manager/-admin shape
              already used elsewhere. */}
          <Text style={styles.pickerLabel}>Enrol in a course (optional)</Text>
          {courseOptions.map((c) => {
            const on = courseId === c.id;
            return (
              <Pressable
                key={c.id}
                testID={`student-course-${c.name}`}
                accessibilityRole="radio"
                // `aria-checked`, because the role is `radio`. `aria-selected`
                // belongs to tabs and options, and AT ignores it here.
                aria-checked={on}
                accessibilityLabel={`Enrol in ${c.name} in ${c.cohortName}`}
                onPress={() => setCourseId(on ? null : c.id)}
                style={styles.pickRow}
              >
                <View style={[styles.tick, on ? styles.tickOn : null]} />
                <View style={styles.pickTextWrap}>
                  <Text style={styles.pickText}>{c.name}</Text>
                  {/* Cohort shown so two courses that share a name (same course
                      in different semesters) are told apart. */}
                  <Text style={styles.pickSub}>{c.cohortName}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <Button
        testID="student-create"
        label="Create account"
        busy={busy}
        disabled={!displayName.trim() || !email.includes('@')}
        block
        onPress={() => void create()}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

function useCourseOptions(isAdmin: boolean, uid: string): CourseOption[] {
  const cohorts = useCohorts(true);
  const adminCourses = useAllCourses(isAdmin);
  const myCourses = useMyCourses(isAdmin ? null : uid);
  const courses = isAdmin ? adminCourses : myCourses;
  const cohortName = (id: string) => cohorts.find((c) => c.id === id)?.name ?? '';
  return courses
    .filter((c) => c.effectiveActive)
    .map((c) => ({ id: c.id, name: c.name, cohortName: cohortName(c.cohortId) }))
    .sort(
      (a, b) => a.cohortName.localeCompare(b.cohortName) || a.name.localeCompare(b.name),
    );
}

const styles = StyleSheet.create({
  picker: { marginTop: spacing(3) },
  pickerLabel: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    paddingVertical: spacing(2),
  },
  pickTextWrap: { flex: 1 },
  pickText: { fontSize: 15, color: t.text.primary },
  pickSub: { fontSize: 13, color: t.text.secondary, marginTop: 1 },
  tick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: t.border.strong,
    backgroundColor: t.bg.raised,
  },
  tickOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
});
