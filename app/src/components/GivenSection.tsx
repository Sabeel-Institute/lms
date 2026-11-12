import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_DUE_DAYS,
  addDays,
  giveRefusal,
  unbreakableDate,
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
  const activeAccount = useMemo(
    () => new Set((students ?? []).filter((s) => s.status === 'active').map((s) => s.uid)),
    [students],
  );
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
    accountActive: true,
    grant: null,
    given: null,
    fromPlus: true,
  });
  const ready = !!given && !!roster && !!students;
  const shown = ready && !(given.size === 0 && blocked);
  /*
   * A SHEET CLOSES WITH THE SECTION. Hidden (a colleague unpublished the
   * recording and nothing was given), the section drew nothing, but the open
   * sheet's state stayed, so it vanished without a word and sprang open again
   * when the recording came back.
   */
  useEffect(() => {
    if (!shown) {
      setAdding(false);
      setEditing(null);
    }
  }, [shown]);
  if (!given || !roster || !students || !shown) return null;

  const rows = [...given.values()].sort((a, b) => (nameOf.get(a.studentUid) ?? '').localeCompare(nameOf.get(b.studentUid) ?? ''));
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
                  accountActive: activeAccount.has(g.studentUid),
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

      {/* MOUNTED ONLY WHILE OPEN, so nothing outlives a close: a give still
          on its way when Close was pressed wrote its result line into the
          next opening. */}
      {adding ? (
      <GiveSheet
        visible
        onClose={() => setAdding(false)}
        recording={recording}
        session={session}
        cls={cls}
        today={today}
        candidates={[...enrolled]
          .filter((uid) => !given.has(uid) && activeAccount.has(uid))
          .map((uid) => ({ uid, name: nameOf.get(uid) ?? uid }))
          .sort((a, b) => a.name.localeCompare(b.name))}
        grantOf={grantOf}
      />
      ) : null}

      {editing ? (
        <RowSheet
          key={editing.uid}
          uid={editing.uid}
          name={nameOf.get(editing.uid) ?? editing.uid}
          opened={editing.expect}
          // ONLY ITS OWN: an answer arriving after this sheet was closed, or
          // another row's opened, closes nothing but this one.
          onClose={() => setEditing((e) => (e?.uid === editing.uid ? null : e))}
          recording={recording}
          session={session}
          cls={cls}
          today={today}
          enrolled={enrolled.has(editing.uid)}
          accountActive={activeAccount.has(editing.uid)}
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
          accountActive: true,
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
        const { outcome, toldToday } = await giveRecording({ recordingId: recording.id, studentUid: picked, openUntil: date, expect: null });
        setDone(giveResult(outcome, pickedName, date, today, toldToday));
        setPicked(null);
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    // Close, not Cancel: the list stays open for the next student, and what
    // was given stays given.
    <Sheet visible={visible} title="Give this recording" onClose={close}>
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
        <Empty>There is nobody else in this class to give it to.</Empty>
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
              onPress={() => {
                // A refusal was about the last student picked.
                setError(null);
                setPicked(selected ? null : c.uid);
              }}
              style={[styles.pick, selected ? styles.picked : null]}
            >
              <Text style={[styles.name, until ? styles.greyed : null]}>{c.name}</Text>
              {until ? <Text style={styles.sub}>{`Required until ${unbreakableDate(until)}; it can be given after that.`}</Text> : null}
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
 * foot. `opened` is what the row showed when the sheet opened, and `expect`
 * what the sheet holds since: every answer from the server replaces it with
 * the record as it now stands. The date typed stays, so Save again applies
 * it on purpose; a date not typed follows the record.
 *
 * ITS STATE IS ITS OWN, gone when it closes. Kept by the section, an answer
 * arriving after the sheet was closed, or another row's opened, wrote into
 * whatever sheet was open then: it sprang open again, or replaced the one
 * being typed in.
 */
function RowSheet({
  uid,
  name,
  opened,
  onClose,
  recording,
  session,
  cls,
  today,
  enrolled,
  accountActive,
  grant,
}: {
  uid: string;
  name: string;
  opened: GivenExpectation;
  onClose: () => void;
  recording: RecordingRow;
  session: SessionRow;
  cls: CourseRow;
  today: string;
  enrolled: boolean;
  accountActive: boolean;
  grant: AssignmentDoc | null;
}) {
  // Its own date while open; a week from today once it has ended.
  const dateOf = (record: GivenExpectation) =>
    record && !isOverdue(record.openUntil, today) ? record.openUntil : addDays(today, DEFAULT_DUE_DAYS);
  const [expect, setExpect] = useState(opened);
  const [date, setDate] = useState(() => dateOf(opened));
  const [typed, setTyped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { active, run } = useOneAtATime();
  /**
   * The record as it now stands, from the server's answer. After a refused
   * TAKE BACK, a date the teacher has not typed follows it: left as the sheet
   * opened, a Save then put back the date a colleague had just moved, which
   * nobody had chosen. After a refused Save the date stays: it is the one
   * they saved, and "Save again to use yours" means it.
   */
  const adopt = (current: GivenExpectation, follow: boolean) => {
    setExpect(current);
    if (follow && !typed) setDate(dateOf(current));
  };
  // Required right now, they keep it after a take back until that date, so
  // nothing stops: the warning says which.
  const stillRequired = requiredUntil(uid, { session, grant, enrolled, recordingStatus: recording.status, today });
  const refusal = giveRefusal({
    studentUid: uid,
    openUntil: date,
    today,
    session,
    recordingStatus: recording.status,
    cls,
    enrolled,
    accountActive,
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
        if (current !== undefined) adopt(current, key === 'take');
        setError(errorText(e));
      }
    });
  const save = () =>
    act('save', async () => {
      const { outcome, current, toldToday } = await giveRecording({ recordingId: recording.id, studentUid: uid, openUntil: date, expect });
      // What the sheet now holds is what it just saved: its next action is
      // judged against that, not against what it showed when it opened.
      setExpect(current);
      setTyped(false);
      setDone(giveResult(outcome, name, date, today, toldToday));
    });
  const takeBack = () =>
    act('take', async () => {
      // Offered only while the sheet holds a record (below), so it always has one.
      if (!expect) return;
      await takeBackRecording({ recordingId: recording.id, studentUid: uid, expect });
      onClose();
    });

  return (
    // Close once something is saved: Cancel over "Now open until …" read as
    // undoing it.
    <Sheet visible title={`Given: ${name}`} onClose={onClose} closeLabel={done ? 'Close' : 'Cancel'}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {/* Taken back by a colleague while open: the sentence above says so,
          and there is nothing left here to change. */}
      {expect ? (
        // Take back confirms in place of everything else on the sheet: it is
        // silent, and stops the audio if they are listening.
        <ConfirmDanger
          testID={`given-takeback-${name}`}
          confirmTestID={`given-takeback-confirm-${name}`}
          label="Take back"
          confirmLabel="Take back"
          warning={
            stillRequired
              ? `Take back from ${name}? It stays open to them until ${unbreakableDate(stillRequired)}, while it is required.`
              : `Take back from ${name}? If they are listening, it stops.`
          }
          busy={active === 'take'}
          onConfirm={takeBack}
        >
          <DateField
            label="Open until"
            value={date}
            onChange={(d) => {
              setDate(d);
              setTyped(true);
            }}
          />
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
