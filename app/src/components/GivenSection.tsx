import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_DUE_DAYS,
  addDays,
  giveRefusal,
  isOverdue,
  requiredUntil,
  type AssignmentDoc,
  type GivenExpectation,
} from '@sabeel/shared';
import { Button, ConfirmDanger, Empty, Grid, IconButton, Notice, SectionTitle, useGridCell } from './ui';
import { Sheet } from './Sheet';
import { DateField } from './DateField';
import { giveRecording, takeBackRecording, type GivenRow } from '../given';
import { changedSince, giveResult, givenStatus, type ClosedBy } from '../givenWords';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import type { CourseRow, EnrollmentRow } from '../structure';
import type { SessionRow } from '../sessions';
import type { RecordingRow } from '../recordings';
import type { StudentRow } from '../students';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * GIVEN TO, on a recording's Progress page: the students staff opened it to
 * one at a time, until a date, optional and counted nowhere.
 *
 * A plus opens the give list (the date and Give at the top, the students
 * below, a tick only selects); each row's pencil opens its own sheet, to move
 * the date or take it back. Every decision is the shared one the server
 * makes (`giveRefusal`), so Save is offered only when it would be taken.
 */
export function GivenSection({
  recording,
  session,
  cls,
  today,
  closedBy,
  given,
  grants,
  roster,
  students,
}: {
  recording: RecordingRow;
  session: SessionRow;
  cls: CourseRow;
  today: string;
  closedBy: ClosedBy;
  given: Map<string, GivenRow> | null;
  grants: Map<string, AssignmentDoc> | null;
  roster: EnrollmentRow[] | null;
  students: StudentRow[] | null;
}) {
  const [adding, setAdding] = useState(false);
  /** The row whose sheet is open, and what it showed when it opened: frozen then. */
  const [editing, setEditing] = useState<{ uid: string; expect: GivenExpectation } | null>(null);
  const nameOf = useMemo(() => new Map((students ?? []).map((s) => [s.uid, s.displayName])), [students]);
  const enrolled = useMemo(
    () => new Set((roster ?? []).filter((e) => e.active).map((e) => e.studentUid)),
    [roster],
  );
  if (!given || !roster || !students) return null;

  // Giving is possible when the register is taken, the recording published and
  // the class playable; the sentence for the first that is not.
  const blocked = giveRefusal({
    studentUid: '',
    openUntil: today,
    today,
    session,
    recordingStatus: recording.status,
    cls,
    enrolled: true,
    grant: null,
    given: null,
    fromPlus: true,
  });
  const rows = [...given.values()].sort((a, b) => (nameOf.get(a.studentUid) ?? '').localeCompare(nameOf.get(b.studentUid) ?? ''));
  if (rows.length === 0 && blocked) return null;
  const grantOf = (uid: string) => grants?.get(uid) ?? null;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <SectionTitle>{`Given to (${rows.length})`}</SectionTitle>
        {blocked ? null : (
          <IconButton testID="given-add" icon="add" bare label="Give this recording to a student" onPress={() => setAdding(true)} />
        )}
      </View>
      {blocked ? <Text style={styles.hint}>{blocked}</Text> : null}
      {rows.length === 0 ? (
        <Empty>Not given to anyone.</Empty>
      ) : (
        <Grid min={300} rows>
          {rows.map((g) => {
            const name = nameOf.get(g.studentUid) ?? g.studentUid;
            return (
              <GivenRowCard
                key={g.id}
                name={name}
                status={givenStatus({
                  given: g,
                  closedBy,
                  enrolled: enrolled.has(g.studentUid),
                  session,
                  grant: grantOf(g.studentUid),
                  recordingStatus: recording.status,
                  today,
                })}
                onEdit={() => setEditing({ uid: g.studentUid, expect: { givenAt: g.givenAt, openUntil: g.openUntil } })}
              />
            );
          })}
        </Grid>
      )}

      <GiveSheet
        visible={adding}
        onClose={() => setAdding(false)}
        recording={recording}
        session={session}
        cls={cls}
        today={today}
        candidates={[...enrolled]
          .filter((uid) => !given.has(uid) && students.some((s) => s.uid === uid && s.status === 'active'))
          .map((uid) => ({ uid, name: nameOf.get(uid) ?? uid }))
          .sort((a, b) => a.name.localeCompare(b.name))}
        grantOf={grantOf}
      />

      {editing ? (
        <RowSheet
          key={editing.uid}
          uid={editing.uid}
          name={nameOf.get(editing.uid) ?? editing.uid}
          expect={editing.expect}
          onExpect={(expect) => setEditing({ uid: editing.uid, expect })}
          onClose={() => setEditing(null)}
          recording={recording}
          session={session}
          cls={cls}
          today={today}
          enrolled={enrolled.has(editing.uid)}
          grant={grantOf(editing.uid)}
        />
      ) : null}
    </View>
  );
}

function GivenRowCard({ name, status, onEdit }: { name: string; status: string; onEdit: () => void }) {
  return (
    <View testID={`given-row-${name}`} style={[styles.row, useGridCell()]}>
      <View style={styles.rowText}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.sub}>{status}</Text>
      </View>
      <IconButton testID={`given-edit-${name}`} icon="edit" bare label={`Change the date or take it back from ${name}`} onPress={onEdit} />
    </View>
  );
}

/**
 * THE GIVE LIST: the date and Give at the top, then the class's students who
 * could be given it. A tick only selects; Give is its own press, so a
 * mis-tap never messages the wrong student. It stays open after a give, with
 * the date kept, for the next.
 */
function GiveSheet({
  visible,
  onClose,
  recording,
  session,
  cls,
  today,
  candidates,
  grantOf,
}: {
  visible: boolean;
  onClose: () => void;
  recording: RecordingRow;
  session: SessionRow;
  cls: CourseRow;
  today: string;
  candidates: { uid: string; name: string }[];
  grantOf: (uid: string) => AssignmentDoc | null;
}) {
  const [date, setDate] = useState(() => addDays(today, DEFAULT_DUE_DAYS));
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { active, run } = useOneAtATime();
  const close = () => {
    setPicked(null);
    setError(null);
    setDone(null);
    setDate(addDays(today, DEFAULT_DUE_DAYS));
    onClose();
  };
  const requiredFor = (uid: string) =>
    requiredUntil(uid, { session, grant: grantOf(uid), enrolled: true, recordingStatus: recording.status, today });
  const pickedName = candidates.find((c) => c.uid === picked)?.name ?? null;
  const refusal =
    picked === null
      ? null
      : giveRefusal({
          studentUid: picked,
          openUntil: date,
          today,
          session,
          recordingStatus: recording.status,
          cls,
          enrolled: true,
          grant: grantOf(picked),
          given: null,
          fromPlus: true,
        });
  const give = () =>
    void run('give', async () => {
      if (!picked || !pickedName) return;
      setError(null);
      setDone(null);
      try {
        const outcome = await giveRecording({ recordingId: recording.id, studentUid: picked, openUntil: date, expect: null });
        setDone(giveResult(outcome, pickedName, date, today));
        setPicked(null);
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <Sheet visible={visible} title="Give this recording" onClose={close} closeLabel="Cancel">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <DateField label="Open until" value={date} onChange={setDate} />
      {refusal ? (
        <Text style={styles.hint}>{refusal}</Text>
      ) : (
        <Button
          testID="give-submit"
          label={pickedName ? `Give to ${pickedName}` : 'Give'}
          disabled={!pickedName || isOverdue(date, today)}
          busy={active === 'give'}
          onPress={give}
        />
      )}
      <Text style={styles.hint}>
        They can play it through the end of that day. It is optional: nothing is required of them, and it isn&apos;t counted.
      </Text>
      {candidates.length === 0 ? (
        <Empty>Everyone in this class already has it or is required to listen.</Empty>
      ) : (
        candidates.map((c) => {
          const until = requiredFor(c.uid);
          const selected = picked === c.uid;
          return (
            <Pressable
              key={c.uid}
              testID={`give-pick-${c.name}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: !!until }}
              disabled={!!until}
              onPress={() => setPicked(selected ? null : c.uid)}
              style={[styles.pick, selected ? styles.picked : null]}
            >
              <Text style={[styles.name, until ? styles.greyed : null]}>{c.name}</Text>
              {until ? <Text style={styles.sub}>{`Required until ${until}; it can be given after that.`}</Text> : null}
            </Pressable>
          );
        })
      )}
    </Sheet>
  );
}

/**
 * ONE ROW'S SHEET: its date, Save while the shared function finds nothing in
 * the way (its sentence in Save's place otherwise), and Take back at the
 * foot. `expect` is what the row showed when the sheet opened: a refusal for
 * a colleague's change replaces it with what is there now, and the date
 * typed stays, so Save again applies it on purpose.
 */
function RowSheet({
  uid,
  name,
  expect,
  onExpect,
  onClose,
  recording,
  session,
  cls,
  today,
  enrolled,
  grant,
}: {
  uid: string;
  name: string;
  expect: GivenExpectation;
  onExpect: (expect: GivenExpectation) => void;
  onClose: () => void;
  recording: RecordingRow;
  session: SessionRow;
  cls: CourseRow;
  today: string;
  enrolled: boolean;
  grant: AssignmentDoc | null;
}) {
  // Its own date while open; a week from today once it has ended.
  const [date, setDate] = useState(() =>
    expect && !isOverdue(expect.openUntil, today) ? expect.openUntil : addDays(today, DEFAULT_DUE_DAYS),
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { active, run } = useOneAtATime();
  const refusal = giveRefusal({
    studentUid: uid,
    openUntil: date,
    today,
    session,
    recordingStatus: recording.status,
    cls,
    enrolled,
    grant,
    given: expect,
    fromPlus: false,
  });
  const act = (key: string, fn: () => Promise<void>) =>
    void run(key, async () => {
      setError(null);
      setDone(null);
      try {
        await fn();
      } catch (e) {
        const current = changedSince(e);
        if (current !== undefined) onExpect(current);
        setError(errorText(e));
      }
    });
  const save = () =>
    act('save', async () => {
      const outcome = await giveRecording({ recordingId: recording.id, studentUid: uid, openUntil: date, expect });
      setDone(giveResult(outcome, name, date, today));
    });
  const takeBack = () =>
    act('take', async () => {
      await takeBackRecording({ recordingId: recording.id, studentUid: uid, expect });
      onClose();
    });

  return (
    <Sheet visible title={`Given: ${name}`} onClose={onClose} closeLabel="Cancel">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {/* Taken back by a colleague while open: the sentence above says so,
          and there is nothing left here to change. */}
      {expect ? (
        // Take back confirms in place of everything else on the sheet: it is
        // silent, and stops the audio at once.
        <ConfirmDanger
          testID={`given-takeback-${name}`}
          confirmTestID={`given-takeback-confirm-${name}`}
          label="Take back"
          confirmLabel="Take back"
          warning={`Take back from ${name}? It stops at once if they are listening.`}
          busy={active === 'take'}
          onConfirm={takeBack}
        >
          <DateField label="Open until" value={date} onChange={setDate} />
          {refusal ? (
            <Text style={styles.hint}>{refusal}</Text>
          ) : (
            <Button testID={`given-save-${name}`} label="Save" busy={active === 'save'} onPress={save} />
          )}
        </ConfirmDanger>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing(5) },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { color: t.text.secondary, fontSize: 14, marginVertical: spacing(2) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(3),
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
    backgroundColor: t.bg.surface,
  },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: t.text.primary, fontSize: 16, fontWeight: '600' },
  sub: { color: t.text.secondary, fontSize: 14, marginTop: spacing(1) },
  greyed: { color: t.text.secondary },
  pick: {
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(3),
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
    marginTop: spacing(2),
  },
  picked: { borderColor: t.accent.base, borderWidth: 2 },
});
