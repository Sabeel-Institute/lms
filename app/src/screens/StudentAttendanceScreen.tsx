import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  INSTITUTE_TIMEZONE,
  canPlayFromCourse,
  grantOutcome,
  isOverdue,
  playVerb,
  todayInZone,
  unbreakableDate,
  type AttendanceStatus,
} from "@sabeel/shared";
import {
  CountsLine,
  Empty,
  Grid,
  Notice,
  Screen,
  Segmented,
  useGridCell,
} from "../components/ui";
import { ClassAssignments, workTally } from "./ClassAssignments";
import { useMySubmissions } from "../coursework";
import { useMyAttendanceState, type AttendanceRecordRow } from "../attendance";

const NO_MARKS: AttendanceRecordRow[] = [];
import { useMyAssignments, useMyCompletions } from "../completion";
import { useRecordingState } from "../recordings";
import type { CourseRow } from "../structure";
import { getTheme, spacing } from "../theme";

const t = getTheme();

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  absent: "Absent",
  excused: "Excused",
};

/**
 * One class, as the student's own record: a tally, then every session they were
 * marked in, with their own mark.
 *
 * Deliberately NOT a way to play anything. An excused row says a recording was
 * required and whether it was listened to; the listening itself lives on the
 * home screen, which is the one place a recording is opened. Two routes to the
 * same audio would mean two places to keep the deadline honest.
 *
 * Everything is joined client-side from three self-constrained queries the
 * student is already allowed to make — their attendance marks, their grants, and
 * their completions — so this screen adds no new permission surface.
 */
export function StudentAttendanceScreen({
  uid,
  cls,
  onOpenWork,
}: {
  uid: string;
  cls: CourseRow;
  onOpenWork: (courseworkId: string) => void;
}) {
  const [tab, setTab] = useState<"sessions" | "assignments">("sessions");
  const allWork = useMySubmissions(uid);
  const work = useMemo(() => (allWork ?? []).filter((s) => s.courseId === cls.id), [allWork, cls.id]);
  const today = todayInZone(INSTITUTE_TIMEZONE);
  // `null` until the listener answers: the tally and "no attendance taken"
  // are the student's record, not a placeholder for one.
  const marksState = useMyAttendanceState(uid, cls.id);
  const marks = marksState ?? NO_MARKS;
  // Memoised rather than a bare `?? []`: a fresh literal every render would
  // make every `useMemo` below recompute every render.
  const granted = useMyAssignments(uid);
  const assignments = useMemo(() => granted ?? [], [granted]);
  const completions = useMyCompletions(uid);

  const bySession = useMemo(
    () => new Map(assignments.map((a) => [a.sessionId, a])),
    [assignments],
  );

  const rows = useMemo(
    () =>
      [...marks].sort(
        (a, b) =>
          b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
      ),
    [marks],
  );

  const tally = useMemo(() => {
    const t0 = { present: 0, absent: 0, excused: 0 };
    for (const m of marks) t0[m.status]++;
    return t0;
  }, [marks]);

  // Still open AND not yet completed. A grant whose date has passed is closed,
  // not outstanding — nothing can be done about it, and counting it would make
  // the number un-clearable.
  const outstanding = useMemo(
    () =>
      // Nothing is owed in a course archived with listening off: the audio is
      // refused, so "still to listen to" would name a thing that cannot be done.
      !canPlayFromCourse(cls)
        ? 0
        : assignments.filter(
            (a) =>
              // THIS CLASS. `useMyAssignments` is constrained on the student and on
              // `active`, so it spans every class they are enrolled in — and the
              // sentence this number drives says "for this class". A student in two
              // classes with one open recording in each read "2 still to listen to"
              // on both pages.
              a.courseId === cls.id &&
              !isOverdue(a.dueDate, today) &&
              !completions.get(a.recordingId)?.completed,
          ).length,
    [assignments, completions, today, cls],
  );

  return (
    /* LIST, like the two student screens this is opened FROM — both of which
       now hold card grids at the same width. Paired with the `Grid` below, the
       reading cap made this the one screen in the app that LOST a column as the
       window grew: 680px of phone layout fits two cards, and crossing the 900px
       breakpoint capped the column at 656 and dropped it to one. */
    <Screen title={cls.name} width="list">
      {/* WHAT THEY STILL OWE COMES FIRST, and in their words. Three attendance
          counts are the register a teacher keeps; the number an adult student
          opens this screen for is how much listening is still outstanding — and
          "excused" is the word that MEANS "you must listen to this", which is
          not something the count says on its own. */}
      <Owed recordings={outstanding} assignments={workTally(work, cls, today).toDo} />

      <View style={styles.tabs}>
      <Segmented
        value={tab}
        testIdPrefix="class-tab"
        options={[
          { value: "sessions", label: `Sessions${marksState === null ? "" : ` (${marks.length})`}` },
          { value: "assignments", label: `Assignments (${work.length})` },
        ]}
        onChange={setTab}
      />
      </View>

      {tab === "assignments" ? (
        allWork === null ? (
          <Empty>Checking your assignments…</Empty>
        ) : (
          <ClassAssignments cls={cls} work={work} onOpenWork={onOpenWork} />
        )
      ) : (
      <>

      {marksState === null ? (
        <Empty>Checking your attendance…</Empty>
      ) : (
        /* The register's three counts on one line. Each NUMBER carries the id,
           so a check reads one counter rather than a digit somewhere near a
           word — which matched the counter next door and passed with the
           labels swapped. Zeros are said: "0 absent" is part of the record. */
        <CountsLine
          counts={[
            { value: tally.present, label: "present", testID: "attendance-tally-present" },
            { value: tally.absent, label: "absent", testID: "attendance-tally-absent" },
            { value: tally.excused, label: "excused", testID: "attendance-tally-excused" },
          ]}
        />
      )}

      {/* No "Sessions" heading: the tab above names the list and counts it. */}
      {marksState === null ? null : rows.length === 0 ? (
        <Empty>No attendance has been taken for this class yet.</Empty>
      ) : (
        <View style={styles.list}>
          <Grid min={330} rows>
            {rows.map((m) => {
              const a = bySession.get(m.sessionId);
              return (
                <MarkRow key={m.id} mark={m}>
                  {a ? (
                    <RecordingLine
                      recordingId={a.recordingId}
                      completed={completions.get(a.recordingId)?.completed ?? false}
                      dueDate={a.dueDate}
                      today={today}
                      playable={canPlayFromCourse(cls)}
                    />
                  ) : null}
                </MarkRow>
              );
            })}
          </Grid>
        </View>
      )}
      </>
      )}
    </Screen>
  );
}

/**
 * WHAT THEY STILL OWE COMES FIRST, in their words: recordings still to
 * complete and assignments still to hand in, for this class only.
 */
function Owed({ recordings, assignments }: { recordings: number; assignments: number }) {
  if (recordings === 0 && assignments === 0) return null;
  const parts = [
    recordings ? `${recordings} ${recordings === 1 ? "recording" : "recordings"} still to complete` : null,
    assignments ? `${assignments} ${assignments === 1 ? "assignment" : "assignments"} to hand in` : null,
  ].filter(Boolean);
  return <Notice tone="info">{`${parts.join(" and ")} for this class.`}</Notice>;
}

/**
 * The line under an excused session. Its own component because the verb —
 * "listen by" or "watch by" — comes from the recording, one document per row.
 * NOTHING UNTIL IT ARRIVES: guessing "listen by" would turn into "watch by"
 * under the reader's eye. A refused read (the course archived with its
 * recordings closed) is an answer, not a fault; the line then says "course
 * archived", which needs no verb.
 */
function RecordingLine({
  recordingId,
  completed,
  dueDate,
  today,
  playable,
}: {
  recordingId: string;
  completed: boolean;
  dueDate: string;
  today: string;
  playable: boolean;
}) {
  const { value: recording, resolved } = useRecordingState(recordingId, "attendanceLine", true);
  if (!resolved) return null;
  return (
    <Text style={styles.listening}>
      {listeningLine(completed, dueDate, today, playable, playVerb(recording?.media ?? {}))}
    </Text>
  );
}

/**
 * What the student owes on an excused session, in one line.
 *
 * Completion is checked before the deadline: someone who listened in time and
 * marked it complete has done what was asked, and telling them afterwards that
 * they "missed" it would be both wrong and the punitive tone the brief rules out.
 */
function listeningLine(
  completed: boolean,
  dueDate: string,
  today: string,
  playable: boolean,
  verb: "Watch" | "Listen",
): string {
  // Non-breaking spaces around the date AND non-breaking hyphens inside it: it
  // is the whole point of the line, and it is the one token a wrap split — see
  // `unbreakableDate`.
  const when = unbreakableDate(dueDate);
  switch (grantOutcome({ completed, dueDate }, today, playable)) {
    case 'complete':
      return 'Recording required · completed';
    // "Missed", the word the student's own home uses for the same session.
    // "not listened" was a second name for one state, and outside the
    // vocabulary the brief declares.
    case 'missed':
      return `Recording required · missed, closed\u00A0${when}`;
    // The home files it under Archived and the count above owes nothing for
    // it; "listen by" here promised something the class no longer offers.
    case 'closed':
      return 'Recording required · course archived';
    case 'open':
      return `Recording required · ${verb.toLowerCase()}\u00A0by\u00A0${when}`;
  }
}

/** One session of the student's register: its title, date, mark and what it asks of them. */
function MarkRow({ mark, children }: { mark: AttendanceRecordRow; children: ReactNode }) {
  return (
    <View testID={`attendance-${mark.title}`} style={[styles.row, useGridCell()]}>
      <View style={styles.rowMain}>
        <Text style={styles.title}>{mark.title}</Text>
        <Text style={styles.date}>{mark.date}</Text>
        {children}
      </View>
      <Text style={styles.status}>{STATUS_LABEL[mark.status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { marginTop: spacing(3), marginBottom: spacing(3) },
  list: { marginTop: spacing(3) },
  row: {
    // Fills the grid cell it is given, so a row of these ends level instead
    // of ragged with its actions at three different heights.
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  rowMain: { flex: 1, paddingRight: spacing(3) },
  title: { fontSize: 15, fontWeight: "600", color: t.text.primary },
  date: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  // The row's point, so it reads as one: what this session asks of them. The
  // attendance mark beside it is the reason it asks, and is set quieter for
  // that — it had the colour and the weight while the sentence that says what
  // to DO was a muted caption under the date.
  listening: {
    fontSize: 14,
    fontWeight: "600",
    color: t.text.primary,
    marginTop: spacing(1),
  },
  status: { fontSize: 13, fontWeight: "600", color: t.text.secondary },
});
