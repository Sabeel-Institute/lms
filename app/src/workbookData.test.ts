import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudentWorkbookInput } from '@sabeel/shared';

/**
 * A MANAGER CAN EXPORT THE WORKBOOK OF ANY STUDENT IN THE COURSES THEY RUN,
 * and its History holds that student's changes in every one of them.
 *
 * The limit that broke it cannot be met on the emulator: production refuses a
 * manager's `courseId in [...]` query once the list names 20 courses (the
 * rules pay one document read per id, against a per-request cap the emulator
 * does not enforce; measured on the live project, 2026-10-14: 19 served, 20
 * refused). So Firestore here is a stand-in that answers queries from a map
 * of documents and refuses exactly what production refuses, and the export is
 * driven through its real code.
 */
type Data = Record<string, unknown>;
type Constraint =
  | { kind: 'where'; field: string; op: '==' | 'in' | 'array-contains'; value: unknown }
  | { kind: 'orderBy'; field: string; dir: 'asc' | 'desc' }
  | { kind: 'limit'; n: number };

const store = new Map<string, Map<string, Data>>();
/** The longest `courseId in` list production serves a manager (measured). */
const PRODUCTION_MANAGER_IN = 19;
const sent: { collection: string; inIds: number }[] = [];

const field = (d: Data, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Data)[k] : undefined), d);

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ name, constraints: [] as Constraint[] }),
  doc: (_db: unknown, name: string, id: string) => ({ name, id }),
  where: (f: string, op: string, value: unknown) => ({ kind: 'where', field: f, op, value }),
  orderBy: (f: string, dir = 'asc') => ({ kind: 'orderBy', field: f, dir }),
  limit: (n: number) => ({ kind: 'limit', n }),
  query: (c: { name: string }, ...constraints: Constraint[]) => ({ name: c.name, constraints }),
  getDocFromServer: async (ref: { name: string; id: string }) => {
    const data = store.get(ref.name)?.get(ref.id);
    return { id: ref.id, exists: () => data !== undefined, data: () => data };
  },
  getDocsFromServer: async (q: { name: string; constraints: Constraint[] }) => {
    const inList = q.constraints.find((c) => c.kind === 'where' && c.op === 'in' && c.field === 'courseId');
    const ids = inList && inList.kind === 'where' ? (inList.value as string[]).length : 0;
    sent.push({ collection: q.name, inIds: ids });
    if (ids > PRODUCTION_MANAGER_IN) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    let rows = [...(store.get(q.name) ?? new Map()).entries()];
    for (const c of q.constraints) {
      if (c.kind === 'where') {
        rows = rows.filter(([, d]) => {
          const v = field(d, c.field);
          return c.op === '==' ? v === c.value : c.op === 'in' ? (c.value as unknown[]).includes(v) : Array.isArray(v) && v.includes(c.value);
        });
      } else if (c.kind === 'orderBy') {
        rows.sort(([, a], [, b]) => (Number(field(a, c.field)) - Number(field(b, c.field))) * (c.dir === 'desc' ? -1 : 1));
      } else {
        rows = rows.slice(0, c.n);
      }
    }
    return { docs: rows.map(([id, d]) => ({ id, data: () => d })) };
  },
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./exportWorkbook', () => ({ saveWorkbook: vi.fn(async () => undefined) }));
const built: StudentWorkbookInput[] = [];
vi.mock('@sabeel/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@sabeel/shared')>();
  return {
    ...shared,
    studentWorkbook: (input: StudentWorkbookInput, ctx: Parameters<typeof shared.studentWorkbook>[1]) => {
      built.push(input);
      return shared.studentWorkbook(input, ctx);
    },
  };
});

const put = (collection: string, id: string, data: Data) => {
  if (!store.has(collection)) store.set(collection, new Map());
  store.get(collection)!.set(id, data);
};

const MANAGER = 'mgr';
const STUDENT = 'stu';

/** A long-serving teacher: `n` classes over the years, the student in every one. */
function world(n: number) {
  put('cohorts', 'c', { name: 'Every term', archived: false, createdAt: 1, createdBy: 'adm' });
  put('staffUsers', MANAGER, { displayName: 'Rukaiya Ahmed' });
  put('students', STUDENT, { displayName: 'Fatima Ahmed', email: 'f@example.com', status: 'active', createdAt: 1, createdBy: 'adm' });
  for (let i = 0; i < n; i += 1) {
    const course = `course-${String(i).padStart(2, '0')}`;
    put('courses', course, {
      cohortId: 'c',
      name: `Class ${i}`,
      archived: i < n - 5,
      effectiveActive: i >= n - 5,
      archivedAccess: false,
      managerUids: [MANAGER],
      createdAt: 1,
      createdBy: 'adm',
    });
    put('enrollments', `${STUDENT}_${course}`, { studentUid: STUDENT, courseId: course, cohortId: 'c', active: true, stretches: [{ from: 1_000 + i, to: null }], enrolledBy: MANAGER });
    put('auditLog', `a-${i}`, {
      at: 1_000 + i,
      actorUid: MANAGER,
      actorRole: 'manager',
      action: 'createEnrollment',
      courseId: course,
      targets: { studentUid: STUDENT, courseId: course },
    });
  }
}

beforeEach(() => {
  store.clear();
  sent.length = 0;
  built.length = 0;
});

describe('a manager’s student workbook', () => {
  it('is made for a student in more of their classes than one query may name, with every class’s history in it', async () => {
    world(35);
    const { exportStudentWorkbook } = await import('./workbookData');
    await exportStudentWorkbook(
      { uid: STUDENT, displayName: 'Fatima Ahmed', email: 'f@example.com', role: 'student', status: 'active', createdAt: 1, createdBy: 'adm' },
      MANAGER,
      false,
    );
    expect(built).toHaveLength(1);
    const enrolledIn = new Set(built[0].history.filter((h) => h.what.startsWith('Enrolled in')).map((h) => h.courseId));
    expect(enrolledIn.size).toBe(35);
    expect(built[0].historyComplete).toBe(true);
    // Every history query names few enough classes for production to serve.
    for (const q of sent.filter((s) => s.collection === 'auditLog')) expect(q.inIds).toBeLessThanOrEqual(PRODUCTION_MANAGER_IN);
  });
});
