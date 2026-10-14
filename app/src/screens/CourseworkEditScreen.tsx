import { useCallback, useEffect, useRef, useState } from 'react';
import { collection, doc } from 'firebase/firestore';
import { StyleSheet, Text, View } from 'react-native';
import {
  COLLECTIONS,
  DEFAULT_DUE_DAYS,
  INSTITUTE_TIMEZONE,
  addDays,
  defaultLateUntil,
  normalizeMarkdown,
  todayInZone,
  unbreakableDate,
  type AttachmentMap,
  type CourseworkGrading,
} from '@sabeel/shared';
import { Button, Card, Chips, ConfirmDanger, Field, Notice, Row, Screen, SectionTitle, SwitchRow } from '../components/ui';
import { DateField } from '../components/DateField';
import { Attachments } from '../components/Attachments';
import { InstructionsEditor } from '../components/InstructionsEditor';
import { useLeaveGuard } from '../components/LeaveGuard';
import {
  closeCoursework,
  createCoursework,
  deleteCoursework,
  postCoursework,
  removeAttachment,
  updateCoursework,
  type CourseworkInput,
  type CourseworkRow,
} from '../coursework';
import { useRosterState, type CourseRow } from '../structure';
import { errorText } from '../errors';
import { db } from '../firebase';
import { useOneAtATime } from '../oneAtATime';
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
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const onBusyChange = useCallback((b: boolean) => setUploading(b), []);
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

  /*
   * WHAT IS STORED, as far as this form knows: what it was opened with, then
   * whatever it last saved. "Unsaved changes" is the form against this; and
   * the server refuses a save when the assignment no longer matches it, which
   * is how one teacher's edit is not overwritten by another's open form.
   */
  const stored = useRef<CourseworkInput>(
    existing
      ? {
          title: existing.title,
          instructions: existing.instructions,
          dueDate: existing.dueDate,
          lateUntil: existing.lateUntil,
          grading: existing.grading,
        }
      : input(),
  );
  // The id a new assignment got, so a second Post after a failed one updates
  // it rather than creating a second assignment.
  const createdId = useRef<string | null>(null);
  /*
   * FILES FIRST, SAVE LATER (Faisal, 2026-10-13). A new assignment's id is
   * reserved when the form opens, so files can be added while it is written:
   * they are held under it, and the ones this form shows join it when it is
   * saved there. Nothing is written until then. Discarded, the form takes its
   * files with it; a tab closed instead leaves them held for thirty days, in
   * case the form is still open somewhere, and then the sweep clears them.
   */
  const [reservedId] = useState(() => doc(collection(db, COLLECTIONS.coursework)).id);
  const [heldFiles, setHeldFiles] = useState<AttachmentMap>({});
  const held = useRef(heldFiles);
  held.current = heldFiles;
  useEffect(
    () => () => {
      if (createdId.current !== null) return;
      for (const fileId of Object.keys(held.current)) {
        void removeAttachment({ courseworkId: reservedId, fileId }).catch(() => undefined);
      }
    },
    [reservedId],
  );
  const now = input();
  const dirty =
    now.title !== stored.current.title ||
    normalizeMarkdown(now.instructions) !== normalizeMarkdown(stored.current.instructions) ||
    now.dueDate !== stored.current.dueDate ||
    now.lateUntil !== stored.current.lateUntil ||
    JSON.stringify(now.grading) !== JSON.stringify(stored.current.grading) ||
    (!existing && createdId.current === null && Object.keys(heldFiles).length > 0);

  // One action at a time: a double-tapped Post must not create two assignments.
  const { active, run: once } = useOneAtATime();
  // The action on its way, for a Back pressed while it is: the screen waits
  // for it, then goes where Back said rather than where the action would have.
  const inFlight = useRef<Promise<boolean> | null>(null);
  const leaveRequested = useRef(false);

  const guard = useLeaveGuard({
    when: dirty || active !== null || uploading,
    settle: async () => {
      const flight = inFlight.current;
      if (uploading || !flight) return false;
      leaveRequested.current = true;
      return flight;
    },
    prompt: uploading
      ? {
          title: 'A file is still uploading',
          message: `Leave now and it stops.${dirty ? ' Your other changes are not saved either.' : ''}`,
          stay: 'Stay',
          leave: 'Leave and stop it',
        }
      : {
          title: 'Discard your changes?',
          message: 'Your changes to this assignment are not saved.',
          stay: 'Keep editing',
          leave: 'Discard',
        },
  });

  /** Run an action; what it returns is where to go after, unless Back came first. */
  const act = (key: string, fn: () => Promise<(() => void) | void>) =>
    void once(key, async () => {
      setError(null);
      let done!: (ok: boolean) => void;
      inFlight.current = new Promise<boolean>((resolve) => {
        done = resolve;
      });
      try {
        const then = await fn();
        done(true);
        if (then && !leaveRequested.current) {
          guard.leaveFreely();
          then();
        }
      } catch (e) {
        setError(errorText(e));
        done(false);
      } finally {
        inFlight.current = null;
        leaveRequested.current = false;
      }
    });

  /** Save what is on the form; returns the assignment's id. */
  const save = async (): Promise<string> => {
    const data = input();
    const id = existing?.id ?? createdId.current;
    if (id) {
      await updateCoursework({ courseworkId: id, ...data, ifUnchanged: stored.current });
    } else {
      createdId.current = (await createCoursework({ courseId: cls.id, ...data, id: reservedId, held: Object.keys(held.current) })).id;
    }
    stored.current = data;
    return id ?? (createdId.current as string);
  };

  const posted = existing?.status === 'posted';
  const others = (key: string) => active !== null && active !== key;
  return (
    <Screen title={existing ? (posted ? 'Edit assignment' : 'Draft assignment') : 'New assignment'} subtitle={cls.name} width="read">
      {guard.element}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card>
        <Field testID="coursework-title" label="Title" value={title} onChangeText={setTitle} autoCapitalize="words" />
        <InstructionsEditor value={instructions} onChange={setInstructions} />
      </Card>

      <SectionTitle>Files</SectionTitle>
      <Card>
        <Attachments
          target="coursework"
          courseworkId={existing?.id ?? reservedId}
          courseId={cls.id}
          files={existing ? existing.files : heldFiles}
          onHeld={existing ? undefined : setHeldFiles}
          editable
          onBusyChange={onBusyChange}
        />
        <Text style={styles.hint}>Worksheets, scans, slides, pictures and audio; up to ten, 25 MB each.</Text>
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
        busy={active === 'delete'}
        testID="coursework-delete"
        confirmTestID="coursework-delete-confirm"
        onConfirm={() =>
          act('delete', async () => {
            await deleteCoursework({ courseworkId: (existing as CourseworkRow).id });
            return onDeleted;
          })
        }
      >
        <Row>
          {posted ? (
            <Button
              testID="coursework-save"
              label="Save changes"
              busy={active === 'save'}
              disabled={!ready || uploading || others('save')}
              onPress={() =>
                act('save', async () => {
                  const id = await save();
                  return () => onSaved(id);
                })
              }
            />
          ) : (
            <>
              <Button
                testID="coursework-post"
                label="Post"
                busy={active === 'post'}
                disabled={!ready || uploading || others('post')}
                onPress={() =>
                  act('post', async () => {
                    const id = await save();
                    await postCoursework({ courseworkId: id });
                    return () => onSaved(id);
                  })
                }
              />
              <Button
                testID="coursework-save-draft"
                label={existing ? 'Save draft' : 'Save as draft'}
                variant="secondary"
                busy={active === 'save'}
                disabled={!ready || uploading || others('save')}
                onPress={() =>
                  act('save', async () => {
                    const id = await save();
                    return () => onSaved(id);
                  })
                }
              />
            </>
          )}
          <Button label="Cancel" variant="quiet" onPress={onCancel} />
        </Row>
        {uploading ? <Text style={styles.waiting}>Ready once every file is up.</Text> : null}
        {posted && existing && existing.closedAt === null ? (
          <View style={styles.close}>
            <Button
              testID="coursework-close"
              label="Stop taking work"
              variant="secondary"
              busy={active === 'close'}
              disabled={others('close')}
              onPress={() =>
                act('close', async () => {
                  await closeCoursework({ courseworkId: existing.id });
                })
              }
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
  waiting: { fontSize: 13, color: t.text.secondary, marginTop: spacing(2) },
  label: { fontSize: 13, fontWeight: '600', color: t.text.secondary, marginBottom: spacing(1) },
  close: { marginTop: spacing(4) },
});
