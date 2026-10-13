import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_DUE_DAYS,
  INSTITUTE_TIMEZONE,
  addDays,
  defaultLateUntil,
  todayInZone,
  unbreakableDate,
  type CourseworkGrading,
} from '@sabeel/shared';
import { Button, Card, Chips, ConfirmDanger, Field, Notice, Row, Screen, SectionTitle, SwitchRow } from '../components/ui';
import { DateField } from '../components/DateField';
import { Attachments } from '../components/Attachments';
import { InstructionsEditor } from '../components/InstructionsEditor';
import {
  closeCoursework,
  createCoursework,
  deleteCoursework,
  postCoursework,
  updateCoursework,
  type CourseworkInput,
  type CourseworkRow,
} from '../coursework';
import { useRosterState, type CourseRow } from '../structure';
import { errorText } from '../errors';
import { getTheme, spacing } from '../theme';

const t = getTheme();

type GradingKind = CourseworkGrading['kind'];

/**
 * Writing an assignment, new or existing (docs/proposals/lms-assignments-
 * proposal.html, section 3, "Writing an assignment"): a title, formatted
 * instructions, files, a due date, how it is graded, and whether late work is
 * taken. Posted at once, or saved as a draft that the course's other teachers
 * see and no student does.
 *
 * The due date prefills to a week from today and late work to a week after
 * it; both are whole days in institute time and never in the past. How it is
 * graded locks once a grade is saved — the server says so if it has been.
 */
export function CourseworkEditScreen({
  cls,
  existing,
  isAdmin,
  onSaved,
  onDeleted,
  onCancel,
}: {
  cls: CourseRow;
  existing: CourseworkRow | null;
  isAdmin: boolean;
  onSaved: (courseworkId: string) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const firstDue = existing?.dueDate ?? addDays(today, DEFAULT_DUE_DAYS);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [dueDate, setDueDate] = useState(firstDue);
  const [kind, setKind] = useState<GradingKind>(existing?.grading.kind ?? 'points');
  const [outOf, setOutOf] = useState(String(existing?.grading.kind === 'points' ? existing.grading.outOf : 10));
  const [acceptLate, setAcceptLate] = useState(existing ? existing.lateUntil !== null : true);
  const [lateUntil, setLateUntil] = useState(existing?.lateUntil ?? defaultLateUntil(firstDue));
  const [lateEdited, setLateEdited] = useState(existing?.lateUntil != null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roster = useRosterState(cls.id);
  const students = roster?.filter((e) => e.active).length ?? null;

  const changeDue = (next: string) => {
    setDueDate(next);
    if (!lateEdited && next) setLateUntil(defaultLateUntil(next));
  };

  const points = Number(outOf);
  const outOfOk = kind === 'scale' || (Number.isInteger(points) && points >= 1 && points <= 1000);
  const input = (): CourseworkInput => ({
    title: title.trim(),
    instructions: instructions.trim(),
    dueDate,
    lateUntil: acceptLate ? lateUntil : null,
    grading: kind === 'points' ? { kind: 'points', outOf: points } : { kind: 'scale' },
  });
  const ready = !!title.trim() && !!dueDate && outOfOk && (!acceptLate || !!lateUntil);

  const run = (key: string, fn: () => Promise<void>) =>
    void (async () => {
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    })();

  /** Save what is on the form; returns the assignment's id. */
  const save = async (): Promise<string> => {
    if (existing) {
      await updateCoursework({ courseworkId: existing.id, ...input() });
      return existing.id;
    }
    return (await createCoursework({ courseId: cls.id, ...input() })).id;
  };

  const posted = existing?.status === 'posted';
  return (
    <Screen title={existing ? (posted ? 'Edit assignment' : 'Draft assignment') : 'New assignment'} subtitle={cls.name} width="read">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card>
        <Field testID="coursework-title" label="Title" value={title} onChangeText={setTitle} autoCapitalize="words" />
        <InstructionsEditor value={instructions} onChange={setInstructions} />
      </Card>

      <SectionTitle>Files</SectionTitle>
      <Card>
        {existing ? (
          <Attachments target="coursework" courseworkId={existing.id} files={existing.files} editable />
        ) : (
          <Text style={styles.hint}>
            Files can be added once it is saved. Worksheets, scans, slides, pictures and audio; up to ten, 25 MB each.
          </Text>
        )}
      </Card>

      <SectionTitle>Dates and grading</SectionTitle>
      <Card>
        <DateField label="Hand in by" value={dueDate} onChange={changeDue} />
        <Text style={styles.hint}>The whole day counts, in institute time.</Text>
        <Text style={styles.label}>Graded as</Text>
        <Chips<GradingKind>
          value={kind}
          testIdPrefix="coursework-grading"
          options={[
            { value: 'points', label: 'Points' },
            { value: 'scale', label: 'Satisfactory / needs work' },
          ]}
          onChange={setKind}
        />
        {kind === 'points' ? (
          <Field testID="coursework-out-of" label="Out of" value={outOf} onChangeText={setOutOf} />
        ) : null}
        <SwitchRow
          testID="coursework-accept-late"
          label="Accept late work"
          description="After the due date, students can still hand in until the date below. It shows as late."
          on={acceptLate}
          onChange={setAcceptLate}
        />
        {acceptLate ? (
          <DateField
            label="Late work until"
            value={lateUntil}
            onChange={(v) => {
              setLateEdited(true);
              setLateUntil(v);
            }}
          />
        ) : null}
      </Card>

      {!posted ? (
        <Text testID="coursework-audience" style={styles.hint}>
          {students === null
            ? ''
            : `Goes to the ${students} ${students === 1 ? 'student' : 'students'} in ${cls.name} when you post it, and to anyone who joins by ${unbreakableDate(dueDate)}. They are notified when you post.`}
        </Text>
      ) : null}

      <ConfirmDanger
        enabled={!!existing}
        label="Delete assignment"
        confirmLabel="Delete permanently"
        warning={
          isAdmin
            ? 'This deletes the assignment and everything on it, including any work students have handed in and their grades. It cannot be undone. Closing it keeps the record.'
            : 'This deletes the assignment and its files. Once any student has started it, only an admin can delete it; close it instead to keep the record.'
        }
        busy={busy === 'delete'}
        testID="coursework-delete"
        confirmTestID="coursework-delete-confirm"
        onConfirm={() =>
          run('delete', async () => {
            await deleteCoursework({ courseworkId: (existing as CourseworkRow).id });
            onDeleted();
          })
        }
      >
        <Row>
          {posted ? (
            <Button
              testID="coursework-save"
              label="Save changes"
              busy={busy === 'save'}
              disabled={!ready}
              onPress={() => run('save', async () => onSaved(await save()))}
            />
          ) : (
            <>
              <Button
                testID="coursework-post"
                label="Post"
                busy={busy === 'post'}
                disabled={!ready}
                onPress={() =>
                  run('post', async () => {
                    const id = await save();
                    await postCoursework({ courseworkId: id });
                    onSaved(id);
                  })
                }
              />
              <Button
                testID="coursework-save-draft"
                label={existing ? 'Save draft' : 'Save as draft'}
                variant="secondary"
                busy={busy === 'save'}
                disabled={!ready}
                onPress={() => run('save', async () => onSaved(await save()))}
              />
            </>
          )}
          <Button label="Cancel" variant="quiet" onPress={onCancel} />
        </Row>
        {posted && existing && existing.closedAt === null ? (
          <View style={styles.close}>
            <Button
              testID="coursework-close"
              label="Stop taking work"
              variant="secondary"
              busy={busy === 'close'}
              onPress={() => run('close', async () => void (await closeCoursework({ courseworkId: existing.id })))}
            />
            <Text style={styles.hint}>Everyone with nothing handed in will show as missed. Work already in can still be graded.</Text>
          </View>
        ) : null}
      </ConfirmDanger>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(3) },
  label: { fontSize: 13, fontWeight: '600', color: t.text.secondary, marginBottom: spacing(1) },
  close: { marginTop: spacing(4) },
});
