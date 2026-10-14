/**
 * Assignments, hand-ins and grades in every ACTIVE course of the LIVE project,
 * for looking at the assignment screens, Today and the workbooks with real
 * volume. Additive, like `seed-demo-prod.mjs`, and removed by the same
 * `wipe-demo-prod.mjs`: everything carries `demoSeed: true`, and every
 * assignment id starts `demo-cw-`, which the wipe also sweeps by reference.
 *
 *   node scripts/seed-demo-coursework.mjs         # DRY RUN: what it would write
 *   node scripts/seed-demo-coursework.mjs --yes   # write it
 *
 * Per course, three to ten assignments already graded and returned, one due
 * a few days ago and waiting to be graded, and one due next week, for every
 * student enrolled: every state a teacher and a student meet, in the
 * proportions a class produces — most work on time, some late, a few missed,
 * the odd student let off or given more time, some work graded on paper.
 * Refused while any demo assignment is already here: wipe first, so a
 * second run cannot leave the first one's extra assignments behind.
 *
 * WRITTEN AS THE CALLABLES WRITE, not through them: the documents have the
 * shapes `coursework.ts` gives them (`check:documents` holds them to it), and
 * no callable runs, so nothing is notified and nothing is audited. Over REST
 * as faisal.shah@oursabeel.com, because this machine's Application Default
 * Credentials belong to another account. Deterministic: a re-run rewrites the
 * same documents.
 */
import { refuseAfterSwitchover } from './lib/before-switchover.mjs';
import { execFileSync } from 'node:child_process';
import {
  FIREBASE_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  SCREEN_CHECKS,
  addDays,
  checkStored,
  isLate,
  submissionId,
  storedDoc,
  todayInZone,
} from '@sabeel/shared';

refuseAfterSwitchover('seed-demo-coursework');
const EXECUTE = process.argv.includes('--yes');
const unknown = process.argv.slice(2).filter((a) => a !== '--yes');
if (unknown.length) {
  console.error('usage: node scripts/seed-demo-coursework.mjs [--yes]');
  process.exit(2);
}
const PROJECT = FIREBASE_PROJECT_ID;
const ACCOUNT = 'faisal.shah@oursabeel.com';

const token = execFileSync('gcloud', ['auth', 'print-access-token', `--account=${ACCOUNT}`], { encoding: 'utf8' }).trim();
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`${method} ${new URL(url).pathname}: ${r.status} ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

// --------------------------------------------------------------- encoding --
function decode(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  throw new Error(`unexpected value ${JSON.stringify(v)}`);
}
function encode(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  throw new Error(`cannot encode ${typeof v}`);
}
async function all(collection) {
  const out = [];
  let page = '';
  for (;;) {
    const r = await call('GET', `${FS}/${collection}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const d of r.documents ?? []) out.push({ id: d.name.split('/').pop(), ...decode({ mapValue: { fields: d.fields ?? {} } }) });
    if (!r.nextPageToken) return out;
    page = r.nextPageToken;
  }
}

// ------------------------------------------------------------- the world --
const [courses, enrollments, staff, coursework] = await Promise.all(['courses', 'enrollments', 'staffUsers', 'coursework'].map(all));
const BY = staff.find((s) => s.email === ACCOUNT)?.id;
if (!BY) throw new Error(`no staff document for ${ACCOUNT}`);
const already = coursework.filter((c) => c.id.startsWith('demo-cw-')).length;
if (already) {
  console.error(`${already} demo assignments are already here. Remove them first: node scripts/wipe-demo-prod.mjs`);
  process.exit(1);
}
const active = courses.filter((c) => c.effectiveActive).sort((a, b) => a.name.localeCompare(b.name));

// A seeded generator, so a re-run writes the same thing.
let seed = 20261014;
const rng = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (xs) => xs[Math.floor(rng() * xs.length)];
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
/** A moment on a civil date, in the institute's afternoon. Chicago is five or six hours behind UTC; at 13:00–19:00 either way it is the same date. */
const at = (date, hour = between(13, 19), minute = between(0, 59)) =>
  Date.parse(`${date}T00:00:00Z`) + ((hour + 5) * 60 + minute) * 60_000;
const TODAY = todayInZone(INSTITUTE_TIMEZONE);
const NOW = Date.now();
const mark = { demoSeed: true };

const WORK = [
  { title: 'Reflection on the session', instructions: 'In a short paragraph, write what stayed with you from this week’s session and why.' },
  { title: 'Summary in your own words', instructions: 'Summarise the main points of the lesson in your own words, in no more than **150 words**.' },
  { title: 'Vocabulary review', instructions: 'Give the meaning of each word from this week’s list, and use three of them in a sentence.' },
  { title: 'Memorise and recite the passage', instructions: 'Memorise the passage studied in class. Recite it to your teacher, or record yourself and attach the file.' },
  { title: 'Short answers: the conditions', instructions: 'Answer each question in one or two sentences:\n\n- What are the conditions?\n- Which one is most often overlooked, and why?' },
  { title: 'Reading response', instructions: 'Read the assigned pages and write three questions you would like to discuss in class.' },
  { title: 'Translation exercise', instructions: 'Translate the five sentences from the handout. Keep the meaning, not the word order.' },
  { title: 'Key terms quiz', instructions: 'Define each key term from the last two sessions, with an example for each.' },
  { title: 'Personal action plan', instructions: 'Choose one practice from this unit and write how you will keep it for the next two weeks.' },
  { title: 'Grammar practice', instructions: 'Complete the exercise from the handout. Show the rule you used for each answer.' },
  { title: 'Case study discussion', instructions: 'Read the case and explain which ruling applies, giving your reasoning.' },
  { title: 'Weekly journal', instructions: 'Keep a short journal of your practice this week and hand in your notes.' },
];
const ANSWERS = [
  'What stayed with me most was the reminder that sincerity comes before action, and that small deeds done consistently are beloved.',
  'The three main points were intention, consistency and gratitude. I found the second the hardest to practise this week.',
  'I have written my answers below, one for each question, and noted where I was unsure.',
  'My summary: the lesson explained the meaning, gave two examples from the text, and ended with how to apply it daily.',
  'I recorded myself reciting the passage twice; the second attempt was smoother. My notes are below.',
  'I found the reading difficult in places, so I wrote my questions about the parts I did not follow.',
  'Here is my translation. I kept the meaning of each sentence and added a note where a word has two senses.',
];
const FEEDBACK = [
  'Clear and well organised. Well done.',
  'A thoughtful answer. Look again at the second point next time.',
  'Good work: your examples made the point well.',
  'Accurate and concise.',
  'You have the main idea; add a little more detail next time.',
  'Excellent. This is exactly what was asked.',
  'Good effort. Review the vocabulary list before the next session.',
  'A strong reflection, in your own words.',
];
const NEEDS_WORK = ['Let’s go over this together in class.', 'Revisit the passage and try it once more in your notes.'];
const NOT_REQUIRED = ['Away for family reasons; agreed with the teacher.', 'Completed in a one-to-one session instead.', 'Medical leave this week.'];
const OUT_OF = [10, 10, 10, 20, 20, 25, 50, 100];

/** A grade: points near 80%, in halves; a scale mark, mostly satisfactory. */
function gradeFor(grading) {
  if (grading.kind === 'scale') {
    return rng() < 0.85 ? { grade: { scale: 'satisfactory' }, feedback: pick(FEEDBACK) } : { grade: { scale: 'needsWork' }, feedback: pick(NEEDS_WORK) };
  }
  const share = Math.min(1, Math.max(0.45, 0.8 + (rng() + rng() + rng() - 1.5) * 0.25));
  return { grade: { points: Math.round(share * grading.outOf * 2) / 2 }, feedback: pick(FEEDBACK) };
}

// ---------------------------------------------------------------- writes --
const writes = []; // { path, doc }
const put = (path, doc) => writes.push({ path, doc: { ...doc, ...mark } });
const report = [];

for (const course of active) {
  const roster = enrollments.filter((e) => e.courseId === course.id && e.active).map((e) => e.studentUid);
  const graded = between(3, 10);
  const titles = [...WORK].sort(() => rng() - 0.5);
  const plans = [
    ...Array.from({ length: graded }, (_, i) => ({ kind: 'graded', due: addDays(TODAY, -12 - 7 * (graded - 1 - i) + between(-1, 1)) })),
    { kind: 'grading', due: addDays(TODAY, -3) },
    { kind: 'upcoming', due: addDays(TODAY, 6) },
  ];
  const counts = { assignments: plans.length, submissions: 0, grades: 0, events: 0 };
  plans.forEach((plan, n) => {
    const id = `demo-cw-${course.id}-${n + 1}`;
    const { title, instructions } = titles[n % titles.length];
    const grading = rng() < 0.25 ? { kind: 'scale' } : { kind: 'points', outOf: pick(OUT_OF) };
    const lateUntil = grading.kind === 'points' && rng() < 0.7 ? addDays(plan.due, 7) : null;
    const postedAt = at(addDays(plan.due, plan.kind === 'upcoming' ? -8 : -between(7, 10)), 9);
    put(`coursework/${id}`, {
      courseId: course.id,
      cohortId: course.cohortId,
      title,
      instructions,
      files: {},
      dueDate: plan.due,
      lateUntil,
      grading,
      status: 'posted',
      closedAt: null,
      postedAt,
      postedBy: BY,
      createdAt: postedAt - 3_600_000,
      createdBy: BY,
      updatedAt: postedAt,
      editedAt: null,
    });

    for (const uid of roster) {
      const sub = {
        studentUid: uid,
        courseworkId: id,
        courseId: course.id,
        cohortId: course.cohortId,
        active: true,
        dueDate: plan.due,
        lateUntil,
        closedEarly: false,
        state: 'open',
        attempt: 1,
        handedInAt: null,
        note: '',
        files: {},
        returned: null,
        attempts: [],
        notRequired: null,
        moreTime: null,
        assignedAt: postedAt,
      };
      let gradeDoc = null;
      const r = rng();
      if (plan.kind === 'graded') {
        if (r < 0.04) {
          sub.notRequired = { reason: pick(NOT_REQUIRED), by: BY, at: at(addDays(plan.due, -2)) };
        } else if (r < 0.1) {
          // Nothing in by the last day: missed.
        } else {
          if (r < 0.13) {
            // More time, and handed in on the new date.
            sub.moreTime = { reason: 'Away for a week; more time agreed.', by: BY, at: at(addDays(plan.due, -2)) };
            sub.dueDate = addDays(plan.due, 7);
            sub.lateUntil = lateUntil ? addDays(lateUntil, 7) : null;
          }
          const onPaper = r >= 0.13 && r < 0.17;
          const late = !onPaper && sub.lateUntil !== null && r >= 0.17 && r < 0.27;
          if (!onPaper) {
            sub.handedInAt = at(addDays(sub.dueDate, late ? between(1, 5) : -between(0, 4)));
            sub.note = pick(ANSWERS);
          }
          const { grade, feedback } = gradeFor(grading);
          const gradedOn = addDays(onPaper ? plan.due : todayInZone(INSTITUTE_TIMEZONE, Math.max(sub.handedInAt, at(plan.due))), between(1, 3));
          const gradedAt = at(gradedOn < TODAY ? gradedOn : addDays(TODAY, -1));
          gradeDoc = { grade, feedback: onPaper ? 'Done in class with the teacher.' : feedback, gradedBy: BY, gradedAt, withoutHandIn: onPaper };
          sub.state = 'returned';
          sub.returned = { grade, feedback: gradeDoc.feedback, at: gradedAt + between(10, 600) * 60_000, seq: 1, retry: false };
        }
      } else if (plan.kind === 'grading') {
        if (r < 0.8) {
          const late = r < 0.15;
          sub.handedInAt = at(addDays(plan.due, late ? between(1, 2) : -between(0, 3)));
          sub.note = pick(ANSWERS);
          sub.state = 'handedIn';
          if (r >= 0.7) {
            // Graded, not given back yet.
            const { grade, feedback } = gradeFor(grading);
            gradeDoc = { grade, feedback, gradedBy: BY, gradedAt: Math.min(NOW - 3_600_000, at(addDays(TODAY, -1))), withoutHandIn: false };
          }
        }
      } else if (r < 0.25) {
        // Handed in early.
        sub.handedInAt = Math.min(NOW - 3_600_000, at(addDays(TODAY, -1)));
        sub.note = pick(ANSWERS);
        sub.state = 'handedIn';
      }

      put(`submissions/${submissionId(uid, id)}`, sub);
      counts.submissions++;
      if (gradeDoc) {
        put(`grades/${submissionId(uid, id)}`, { studentUid: uid, courseworkId: id, courseId: course.id, ...gradeDoc });
        counts.grades++;
      }
      if (sub.handedInAt !== null) {
        put(`submissionEvents/demo-ev-${id}-${uid}`, {
          studentUid: uid,
          courseworkId: id,
          courseId: course.id,
          kind: 'handIn',
          attempt: 1,
          at: sub.handedInAt,
          late: isLate(sub.handedInAt, sub.dueDate, INSTITUTE_TIMEZONE),
        });
        counts.events++;
      }
    }
  });
  report.push({ course: course.name, students: roster.length, graded, ...counts });
}

console.log(`${EXECUTE ? 'WRITING to' : 'DRY RUN for'} ${PROJECT}, as ${ACCOUNT}; today is ${TODAY}\n`);
for (const r of report) {
  console.log(
    `  ${r.course.padEnd(26)} ${String(r.students).padStart(3)} students · ${String(r.assignments).padStart(2)} assignments (${r.graded} graded, 1 to grade, 1 upcoming) · ${r.submissions} submissions · ${r.grades} grades · ${r.events} hand-ins`,
  );
}
// Every document held to its type, and the screens' helpers run on it, as
// `check:documents` will read them once written: a shape this gets wrong is
// refused here rather than found on a screen.
const wrong = writes.flatMap(({ path, doc }) => {
  const collection = path.split('/')[0];
  const problems = checkStored(collection, doc).map((f) => `${path}: lacks ${f}`);
  for (const check of SCREEN_CHECKS[collection] ?? []) {
    try {
      check(storedDoc(collection, doc), TODAY);
    } catch (e) {
      problems.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
});
if (wrong.length) {
  console.error(`REFUSED: ${wrong.length} documents do not read as the app reads them:\n  ${wrong.slice(0, 10).join('\n  ')}`);
  process.exit(1);
}
console.log(`\n  ${writes.length} documents in all`);
if (!EXECUTE) {
  console.log('\nDry run. Re-run with --yes to write.');
  process.exit(0);
}
for (let i = 0; i < writes.length; i += 400) {
  await call('POST', `${FS}:commit`, {
    writes: writes.slice(i, i + 400).map(({ path, doc }) => ({
      update: { name: `projects/${PROJECT}/databases/(default)/documents/${path}`, fields: encode(doc).mapValue.fields },
    })),
  });
}
console.log(`\nwrote ${writes.length} documents`);
