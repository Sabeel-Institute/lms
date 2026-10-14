import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

let testEnv: RulesTestEnvironment;

/**
 * `host:port` from the emulator env var the CLI exports.
 *
 * NO fallback port, deliberately. `emulators:exec` always sets these
 * (`firebase-tools/lib/emulator/env.js`), so an unset var means the suite is
 * running outside the wrapper — and a hardcoded default does not rescue that,
 * it points at whatever happens to be on that port. On a machine where three
 * checkouts run emulators, that is a SIBLING's: it reads and writes happily and
 * turns a rules suite green against the wrong database. Failing loudly is the
 * only safe behaviour.
 */
function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  // Literal 127.0.0.1, never 'localhost': the emulators bind IPv4 only, while
  // 'localhost' can resolve to IPv6 ::1 first and fail at connect.
  return { host: host || '127.0.0.1', port: Number(port) };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      ...hostPort('FIRESTORE_EMULATOR_HOST'),
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

const MINE = 'mgrMine';
const THEIRS = 'mgrTheirs';
const STUDENT = 'stu1';
const OUTSIDER = 'stu2';
const CLASS_MINE = 'classMine';
const CLASS_THEIRS = 'classTheirs';
const REC = 'rec1';

// Every ledger-read collection shares the same shape: a `courseId` and a
// `studentUid`. Seed one of each in "my" class and one in "theirs".
const LEDGER_COLLECTIONS = [
  COLLECTIONS.completions,
  COLLECTIONS.listeningProgress,
  COLLECTIONS.completionEvents,
  COLLECTIONS.completionOverrides,
];

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { admin1: 'admin', [MINE]: 'manager', [THEIRS]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, COLLECTIONS.courses, CLASS_MINE), { cohortId: 'c1', managerUids: [MINE] });
    await setDoc(doc(db, COLLECTIONS.courses, CLASS_THEIRS), { cohortId: 'c1', managerUids: [THEIRS] });
    for (const name of LEDGER_COLLECTIONS) {
      await setDoc(doc(db, name, `${STUDENT}_${REC}`), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: true,
        actor: 'student',
      });
      await setDoc(doc(db, name, `${OUTSIDER}_${REC}`), {
        studentUid: OUTSIDER,
        recordingId: REC,
        courseId: CLASS_THEIRS,
        completed: true,
        actor: 'student',
      });
    }
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const mgrMine = () => ctx(MINE, 'manager');
const mgrTheirs = () => ctx(THEIRS, 'manager');
const admin = () => ctx('admin1', 'admin');
const student = () => ctx(STUDENT, 'student');

describe('Phase 5 staff ledger reads', () => {
  for (const name of LEDGER_COLLECTIONS) {
    describe(name, () => {
      it('a manager lists their own class, scoped', async () => {
        await assertSucceeds(
          getDocs(query(collection(mgrMine().firestore(), name), where('courseId', '==', CLASS_MINE))),
        );
      });

      it('an admin lists everything', async () => {
        await assertSucceeds(getDocs(collection(admin().firestore(), name)));
      });

      /*
       * A `get`, NOT A LIST — and the positive case, which was missing.
       *
       * `listeningProgress` and `completions` declare `get` and `list` as
       * separate statements, and every staff assertion in this file was a
       * `getDocs`. So the staff arm of `allow get` was covered only by the
       * denial below: deleting `|| (resource != null &&
       * staffManagesCourse(resource.data.courseId))` from it left this whole
       * suite green while the ledger's per-row reads broke.
       */
      it('a manager reads a single row in their own class', async () => {
        await assertSucceeds(getDoc(doc(mgrMine().firestore(), name, `${STUDENT}_${REC}`)));
      });

      it('an admin reads a single row', async () => {
        await assertSucceeds(getDoc(doc(admin().firestore(), name, `${STUDENT}_${REC}`)));
      });

      /*
       * A GET OF A DOCUMENT THAT IS NOT THERE.
       *
       * `resource` is null then, and dereferencing it is a rules EVALUATION
       * ERROR rather than a denial — so a screen asking for a student's own row
       * on a recording that has none gets a failure, not an answer. Absence is
       * the usual case for three of these four collections.
       *
       * `completionEvents` is the exception: its ids are auto-generated, so
       * there is nothing to bind a null arm to and nothing reads it by id, and
       * an unbound arm would answer about anybody's row.
       */
      const idBound = name !== COLLECTIONS.completionEvents;

      it.runIf(idBound)('answers a student asking for their own row before it exists', async () => {
        await assertSucceeds(getDoc(doc(student().firestore(), name, `${STUDENT}_never`)));
      });

      /*
       * AND ONLY ABOUT THEIR OWN. Absent-is-allowed against present-is-denied is
       * an existence oracle, and these ids are `${uid}_${recordingId}` — so an
       * unbound arm would tell one student whether a named classmate had a row
       * on a named recording.
       */
      it.runIf(idBound)('does not answer for a row under someone else’s id', async () => {
        await assertFails(getDoc(doc(student().firestore(), name, `${OUTSIDER}_never`)));
      });

      it('still refuses a manager a row that is not there', async () => {
        // The null arm must not become a hole: no document means no courseId to
        // check, so staff get nothing rather than everything.
        await assertFails(getDoc(doc(mgrMine().firestore(), name, `${STUDENT}_never`)));
      });

      it('a manager cannot read another class’s row', async () => {
        await assertFails(getDoc(doc(mgrTheirs().firestore(), name, `${STUDENT}_${REC}`)));
      });

      it('a manager cannot list another class', async () => {
        await assertFails(
          getDocs(query(collection(mgrMine().firestore(), name), where('courseId', '==', CLASS_THEIRS))),
        );
      });

      // ---- The shape the app actually sends -------------------------------
      //
      // Everything above asserts the rule's INTENT with `courseId ==`, which is
      // the shape the rules were written for. That is not the same as the shape
      // the app sends, and the gap shipped: the recording ledger read
      // `recordingId ==` alone, and every one of its four listeners was denied
      // for every manager on every recording while this suite stayed green.
      //
      // Firestore evaluates a `list` rule against the QUERY's constraints, not
      // only against the documents it would return. The staff arm here resolves
      // get(/courses/$(resource.data.courseId)), so a query that does not pin
      // courseId leaves that path unresolvable and is refused outright — even
      // when it matches nothing. Hence the empty-result case below: it is not a
      // curiosity, it is the case that makes the denial independent of data and
      // therefore total.
      it('a manager CANNOT list by recordingId alone — the rule needs courseId', async () => {
        await assertFails(
          getDocs(query(collection(mgrMine().firestore(), name), where('recordingId', '==', REC))),
        );
      });

      it('…not even when the query matches nothing', async () => {
        await assertFails(
          getDocs(
            query(collection(mgrMine().firestore(), name), where('recordingId', '==', 'noSuchRecording')),
          ),
        );
      });

      it('a manager CAN list one recording within a class they run', async () => {
        await assertSucceeds(
          getDocs(
            query(
              collection(mgrMine().firestore(), name),
              where('courseId', '==', CLASS_MINE),
              where('recordingId', '==', REC),
            ),
          ),
        );
      });

      it('…and an unmatched recording inside their own class is still fine', async () => {
        await assertSucceeds(
          getDocs(
            query(
              collection(mgrMine().firestore(), name),
              where('courseId', '==', CLASS_MINE),
              where('recordingId', '==', 'noSuchRecording'),
            ),
          ),
        );
      });
    });
  }
});

describe('completionOverrides', () => {
  it('a student reads their OWN override (their accountability details)', async () => {
    await assertSucceeds(
      getDoc(doc(student().firestore(), COLLECTIONS.completionOverrides, `${STUDENT}_${REC}`)),
    );
  });

  it("a student cannot read another student's override", async () => {
    await assertFails(
      getDoc(doc(student().firestore(), COLLECTIONS.completionOverrides, `${OUTSIDER}_${REC}`)),
    );
  });

  it('a student lists their own overrides — the shape the home sends — and nobody else\'s', async () => {
    // `useMyOverrides` asks by studentUid; the only student case above is a
    // `get`, so the list arm was asserted nowhere.
    await assertSucceeds(
      getDocs(
        query(collection(student().firestore(), COLLECTIONS.completionOverrides), where('studentUid', '==', STUDENT)),
      ),
    );
    await assertFails(
      getDocs(
        query(collection(student().firestore(), COLLECTIONS.completionOverrides), where('studentUid', '==', OUTSIDER)),
      ),
    );
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.completionOverrides)));
  });

  it('no client may write an override (server-only)', async () => {
    for (const c of [mgrMine(), admin(), student()]) {
      await assertFails(
        setDoc(doc(c.firestore(), COLLECTIONS.completionOverrides, `${STUDENT}_${REC}`), {
          studentUid: STUDENT,
          recordingId: REC,
          courseId: CLASS_MINE,
          completed: true,
          reason: 'forged',
          overriddenBy: 'x',
          at: 1,
        }),
      );
    }
  });
});
