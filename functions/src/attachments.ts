import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { fileTypeFromTokenizer } from 'file-type';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TEACHER_AUDIO_SEC,
  attachmentContentType,
  attachmentKind,
  attachmentProblem,
  canHandIn,
  courseworkFileKey,
  submissionId,
  todayInZone,
  workFileKey,
  workState,
  type AttachmentContentType,
  type AttachmentFile,
  type AttachmentMap,
  type CourseDoc,
  type CourseworkDoc,
  type DraftDoc,
  type SubmissionDoc,
  type TokenClaims,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { reportedCall } from './reported';
import { requireCourseScope, requireStudent } from './guards';
import { MEDIA_READ_SECRETS, MEDIA_WRITE_SECRETS, deleteObject, head, signGet, signPut } from './mediaStore';
import { UnreadableMedia, judgeProbe, objectTokenizer, probeObject } from './mediaProbe';

/**
 * Files on assignments: a teacher's on the assignment itself, a student's on
 * their work (docs/plans/ASSIGNMENTS.md, step A3).
 *
 * Every upload URL is signed by a callable that has already checked who may
 * add the file there, that the work is still open and that the ten-file cap
 * holds; every read link by one that has checked who may see it. And every
 * file is LOOKED AT when it arrives: the type is what the bytes say, not what
 * the name claims, so a video renamed `.m4a` is refused, and a teacher's
 * 15-minute audio limit is measured from the file itself.
 *
 *   start    → an `attachmentUploads` record, and a write-once PUT URL
 *   finalize → size, then the bytes judged against the declared kind, then
 *              the file joins the assignment or the student's draft
 */

const db = () => getFirestore();
const UPLOAD_URL_TTL_MS = 30 * 60 * 1000;
/** Read links last an hour: long enough to read a worksheet, short enough not to travel. */
const READ_URL_TTL_MS = 60 * 60 * 1000;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_NAME = 200;

/** Where a file goes: the assignment (a teacher's), or a student's own work on it. */
export type AttachmentTarget = 'coursework' | 'work';

/** Server-only record of an attachment on its way in (`attachmentUploads/{fileId}`). */
export interface AttachmentUploadDoc {
  target: AttachmentTarget;
  courseworkId: string;
  courseId: string;
  /** The student whose work it joins; null for a teacher's file. */
  studentUid: string | null;
  uploadedBy: string;
  name: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  storageKey: string;
  startedAt: number;
}

const uploadRef = (fileId: string) => db().collection(COLLECTIONS.attachmentUploads).doc(fileId);
const cwRef = (id: string) => db().collection(COLLECTIONS.coursework).doc(id);
const subRef = (uid: string, cwId: string) => db().collection(COLLECTIONS.submissions).doc(submissionId(uid, cwId));
const draftRef = (uid: string, cwId: string) => db().collection(COLLECTIONS.drafts).doc(submissionId(uid, cwId));

function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new HttpsError('invalid-argument', `${name} is required.`);
  return v;
}

async function readCoursework(id: string): Promise<CourseworkDoc> {
  const snap = await cwRef(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such assignment.');
  return snap.data() as CourseworkDoc;
}

/** A student's open work, which is the only work files can be added to. */
async function openWork(studentUid: string, cwId: string): Promise<SubmissionDoc> {
  const sub = (await subRef(studentUid, cwId).get()).data() as SubmissionDoc | undefined;
  if (!sub?.active) throw new HttpsError('permission-denied', 'That assignment is not yours.');
  const course = (await db().collection(COLLECTIONS.courses).doc(sub.courseId).get()).data() as CourseDoc;
  if (!canHandIn(workState(sub, todayInZone(INSTITUTE_TIMEZONE), course.effectiveActive))) {
    throw new HttpsError('failed-precondition', 'This work is not open for changes.');
  }
  return sub;
}

/** How many files a target already has, counting those still on their way in. */
async function fileCount(target: AttachmentTarget, cwId: string, studentUid: string | null): Promise<number> {
  const stored =
    target === 'coursework'
      ? Object.keys((await readCoursework(cwId)).files).length
      : Object.keys(((await draftRef(studentUid as string, cwId).get()).data() as DraftDoc | undefined)?.files ?? {}).length;
  const pending = await db()
    .collection(COLLECTIONS.attachmentUploads)
    .where('courseworkId', '==', cwId)
    .where('studentUid', '==', studentUid)
    .get();
  return stored + pending.size;
}

// ----------------------------------------------------------------- start --

interface StartInput {
  target: AttachmentTarget;
  courseworkId: string;
  name: string;
  sizeBytes: number;
}

function validateStartAttachment(data: unknown): StartInput {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.target !== 'coursework' && d.target !== 'work') {
    throw new HttpsError('invalid-argument', 'target is the assignment or your work.');
  }
  const name = typeof d.name === 'string' ? d.name.trim().slice(0, MAX_NAME) : '';
  if (!name) throw new HttpsError('invalid-argument', 'A file name is required.');
  if (typeof d.sizeBytes !== 'number' || !Number.isInteger(d.sizeBytes) || d.sizeBytes < 0) {
    throw new HttpsError('invalid-argument', 'sizeBytes must be a whole number.');
  }
  const problem = attachmentProblem(name, d.sizeBytes);
  if (problem) throw new HttpsError('invalid-argument', problem);
  return { target: d.target, courseworkId: idOf(d.courseworkId, 'courseworkId'), name, sizeBytes: d.sizeBytes };
}

async function beginAttachment(input: StartInput, uploaderUid: string, studentUid: string | null, courseId: string) {
  if ((await fileCount(input.target, input.courseworkId, studentUid)) >= MAX_ATTACHMENTS) {
    throw new HttpsError('failed-precondition', `There can be ${MAX_ATTACHMENTS} files at most.`);
  }
  const fileId = db().collection(COLLECTIONS.attachmentUploads).doc().id;
  const contentType = attachmentContentType(input.name) as AttachmentContentType;
  const storageKey =
    input.target === 'coursework'
      ? courseworkFileKey(input.courseworkId, fileId)
      : workFileKey(studentUid as string, input.courseworkId, fileId);
  const doc: AttachmentUploadDoc = {
    target: input.target,
    courseworkId: input.courseworkId,
    courseId,
    studentUid,
    uploadedBy: uploaderUid,
    name: input.name,
    contentType,
    sizeBytes: input.sizeBytes,
    storageKey,
    startedAt: Date.now(),
  };
  await uploadRef(fileId).set(doc);
  const put = await signPut(storageKey, contentType, UPLOAD_URL_TTL_MS);
  return { fileId, url: put.url, headers: put.headers, expiresAt: put.expiresAt };
}

/**
 * Not audited: nothing changes for anyone until the file is confirmed, and
 * a teacher's file is audited then.
 */
export const startAttachmentUpload = reportedCall(async (req) => {
  const input = validateStartAttachment(req.data);
  const cw = await readCoursework(input.courseworkId);
  if (input.target === 'coursework') {
    const uid = await requireCourseScope(req, cw.courseId);
    return beginAttachment(input, uid, null, cw.courseId);
  }
  const uid = requireStudent(req);
  await openWork(uid, input.courseworkId);
  return beginAttachment(input, uid, uid, cw.courseId);
}, MEDIA_WRITE_SECRETS);

// -------------------------------------------------------------- finalize --

const ZIP_FAMILY = ['zip', 'docx', 'xlsx', 'pptx'];
const OLE_FAMILY = ['cfb', 'doc', 'xls', 'ppt'];

/**
 * Whether the bytes are the kind of file the name says, and an audio file's
 * length. Office files are ZIP (or, for the old formats, OLE) containers, so
 * the container is what is checked; text has no signature, so text is any
 * file the detector recognises as nothing in particular.
 */
async function judgeAttachment(
  up: AttachmentUploadDoc,
  sizeBytes: number,
): Promise<{ ok: true; durationSec: number | null } | { ok: false; reason: string }> {
  const kind = attachmentKind(up.contentType);
  if (kind === 'audio') {
    let verdict;
    try {
      verdict = judgeProbe(await probeObject(up.storageKey, sizeBytes), 'audio');
    } catch (e) {
      if (!(e instanceof UnreadableMedia)) throw e;
      return { ok: false, reason: 'This file could not be read as audio.' };
    }
    if (!verdict.ok) {
      // The upload probe's wording names M4A and MP3; attachments take more.
      return { ok: false, reason: /picture/.test(verdict.reason) ? 'Video cannot be attached. Attach the audio alone.' : 'This audio could not be read. Save it as M4A or MP3 and attach that.' };
    }
    if (up.target === 'coursework' && verdict.durationSec > MAX_TEACHER_AUDIO_SEC) {
      return {
        ok: false,
        reason: 'Audio on an assignment can be 15 minutes at most. Class recordings reach students through the register, never as attachments.',
      };
    }
    return { ok: true, durationSec: verdict.durationSec };
  }
  const detected = await fileTypeFromTokenizer(await objectTokenizer(up.storageKey, sizeBytes));
  const ext = up.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const fits =
    ext === 'txt'
      ? detected === undefined
      : ext === 'pdf'
        ? detected?.ext === 'pdf'
        : ['docx', 'xlsx', 'pptx'].includes(ext)
          ? ZIP_FAMILY.includes(detected?.ext ?? '')
          : ['doc', 'xls', 'ppt'].includes(ext)
            ? OLE_FAMILY.includes(detected?.ext ?? '')
            : detected?.mime === up.contentType;
  if (fits) return { ok: true, durationSec: null };
  if (detected?.mime.startsWith('video/')) return { ok: false, reason: 'Video cannot be attached.' };
  return { ok: false, reason: `This file is not the ${kind} its name says it is. Save it again and attach the new copy.` };
}

interface FinalizeInput {
  courseworkId: string;
  fileId: string;
}

function validateFinalizeAttachment(data: unknown): FinalizeInput {
  const d = (data ?? {}) as Record<string, unknown>;
  return { courseworkId: idOf(d.courseworkId, 'courseworkId'), fileId: idOf(d.fileId, 'fileId') };
}

/** Throw a file away with the reason the person is told. */
async function discard(fileId: string, up: AttachmentUploadDoc, reason: string): Promise<never> {
  await deleteObject(up.storageKey);
  await uploadRef(fileId).delete();
  throw new HttpsError('failed-precondition', reason);
}

/**
 * Confirm a file arrived and put it where it belongs. The cap and the open
 * state are checked again here, in the transaction that adds the file: two
 * uploads started together must not both land as the eleventh.
 */
async function finalizeAttachmentRecord(input: FinalizeInput, callerUid: string) {
  const snap = await uploadRef(input.fileId).get();
  const up = snap.data() as AttachmentUploadDoc | undefined;
  if (!up || up.courseworkId !== input.courseworkId || up.uploadedBy !== callerUid) {
    throw new HttpsError('failed-precondition', 'That file is not on its way in. Add it again.');
  }
  const object = await head(up.storageKey);
  if (!object) throw new HttpsError('failed-precondition', 'The file did not arrive. Add it again.');
  if (object.sizeBytes > MAX_ATTACHMENT_BYTES) return discard(input.fileId, up, 'Too large: a file can be 25 MB at most.');
  const verdict = await judgeAttachment(up, object.sizeBytes);
  if (!verdict.ok) return discard(input.fileId, up, verdict.reason);

  const file: AttachmentFile = {
    id: input.fileId,
    name: up.name,
    contentType: up.contentType,
    sizeBytes: object.sizeBytes,
    durationSec: verdict.durationSec,
    storageKey: up.storageKey,
    // Chosen-order, not arrival-order (AttachmentFile.addedAt).
    addedAt: up.startedAt,
  };
  try {
    await db().runTransaction(async (tx) => {
      if (up.target === 'coursework') {
        const cw = (await tx.get(cwRef(up.courseworkId))).data() as CourseworkDoc | undefined;
        if (!cw) throw new HttpsError('not-found', 'That assignment was deleted.');
        if (Object.keys(cw.files).length >= MAX_ATTACHMENTS) {
          throw new HttpsError('failed-precondition', `There can be ${MAX_ATTACHMENTS} files at most.`);
        }
        tx.update(cwRef(up.courseworkId), {
          [`files.${input.fileId}`]: file,
          updatedAt: Date.now(),
          ...(cw.status === 'posted' ? { editedAt: Date.now() } : {}),
        });
      } else {
        const uid = up.studentUid as string;
        const sub = (await tx.get(subRef(uid, up.courseworkId))).data() as SubmissionDoc | undefined;
        if (sub?.state !== 'open' || !sub.active) throw new HttpsError('failed-precondition', 'This work is not open for changes.');
        const draft = (await tx.get(draftRef(uid, up.courseworkId))).data() as DraftDoc | undefined;
        if (Object.keys(draft?.files ?? {}).length >= MAX_ATTACHMENTS) {
          throw new HttpsError('failed-precondition', `There can be ${MAX_ATTACHMENTS} files at most.`);
        }
        if (draft) {
          tx.update(draftRef(uid, up.courseworkId), { [`files.${input.fileId}`]: file, updatedAt: Date.now() });
        } else {
          const fresh: DraftDoc = {
            studentUid: uid,
            courseworkId: up.courseworkId,
            courseId: up.courseId,
            note: '',
            files: { [input.fileId]: file },
            updatedAt: Date.now(),
          };
          tx.set(draftRef(uid, up.courseworkId), fresh);
        }
      }
      tx.delete(uploadRef(input.fileId));
    });
  } catch (e) {
    // Refused at the last moment: nothing points at the object, so it goes.
    await deleteObject(up.storageKey);
    await uploadRef(input.fileId).delete();
    throw e;
  }
  return { file, target: up.target };
}

/** A teacher's file on the assignment is in the audit history; a student's work is not. */
export const finalizeAttachment = auditedCall(
  'finalizeAttachment',
  async (req, audit) => {
    const input = validateFinalizeAttachment(req.data);
    const cw = await readCoursework(input.courseworkId);
    const uid = isStudentCaller(req)
      ? requireStudent(req)
      : await requireCourseScope(req, cw.courseId);
    const res = await finalizeAttachmentRecord(input, uid);
    audit.courseId = cw.courseId;
    audit.targets = { courseworkId: input.courseworkId };
    audit.noop = res.target === 'work';
    audit.detail = { file: res.file.name };
    return { file: res.file };
  },
  MEDIA_WRITE_SECRETS,
);

function isStudentCaller(req: CallableRequest): boolean {
  return (req.auth?.token as TokenClaims | undefined)?.role === 'student';
}

// ---------------------------------------------------------------- remove --

/**
 * Take a file off. A teacher's from the assignment, at any time. A student's
 * only from their draft — work handed in is the teacher's to see, and comes
 * back to the draft only by taking it back.
 */
export const removeAttachment = auditedCall(
  'removeAttachment',
  async (req, audit) => {
    const d = (req.data ?? {}) as Record<string, unknown>;
    const cwId = idOf(d.courseworkId, 'courseworkId');
    const fileId = idOf(d.fileId, 'fileId');
    const cw = await readCoursework(cwId);
    audit.courseId = cw.courseId;
    audit.targets = { courseworkId: cwId };
    let removed: AttachmentFile | undefined;
    if (isStudentCaller(req)) {
      const uid = requireStudent(req);
      await openWork(uid, cwId);
      const draft = (await draftRef(uid, cwId).get()).data() as DraftDoc | undefined;
      removed = draft?.files[fileId];
      if (!removed) throw new HttpsError('not-found', 'No such file on your work.');
      await draftRef(uid, cwId).update({ [`files.${fileId}`]: FieldValue.delete(), updatedAt: Date.now() });
      audit.noop = true;
    } else {
      await requireCourseScope(req, cw.courseId);
      removed = cw.files[fileId];
      if (!removed) throw new HttpsError('not-found', 'No such file on the assignment.');
      await cwRef(cwId).update({
        [`files.${fileId}`]: FieldValue.delete(),
        updatedAt: Date.now(),
        ...(cw.status === 'posted' ? { editedAt: Date.now() } : {}),
      });
      audit.detail = { file: removed.name };
    }
    await deleteObject(removed.storageKey);
    return { removed: fileId };
  },
  MEDIA_WRITE_SECRETS,
);

// ------------------------------------------------------------------ read --

/** A student's file, wherever it is kept: the work handed in, an earlier attempt, or (for them alone) the draft. */
function findWorkFile(sub: SubmissionDoc | undefined, draft: DraftDoc | undefined, fileId: string): AttachmentFile | undefined {
  const maps: AttachmentMap[] = [sub?.files ?? {}, ...(sub?.attempts ?? []).map((a) => a.files), draft?.files ?? {}];
  return maps.map((m) => m[fileId]).find(Boolean);
}

/**
 * A link that opens one file for an hour, for someone allowed to see it: a
 * teacher's file for the class's teachers and the students it was given to;
 * a student's file for that student and the class's teachers — but a draft
 * for the student alone, since nobody sees work before it is handed in.
 */
export const getAttachmentUrl = reportedCall(async (req) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const cwId = idOf(d.courseworkId, 'courseworkId');
  const fileId = idOf(d.fileId, 'fileId');
  const studentUid = d.studentUid === undefined || d.studentUid === null ? null : idOf(d.studentUid, 'studentUid');
  const cw = await readCoursework(cwId);
  let file: AttachmentFile | undefined;
  if (isStudentCaller(req)) {
    const uid = requireStudent(req);
    const sub = (await subRef(uid, cwId).get()).data() as SubmissionDoc | undefined;
    if (!sub?.active || cw.status !== 'posted') throw new HttpsError('permission-denied', 'That assignment is not yours.');
    if (studentUid === null) file = cw.files[fileId];
    else if (studentUid === uid) file = findWorkFile(sub, (await draftRef(uid, cwId).get()).data() as DraftDoc | undefined, fileId);
    else throw new HttpsError('permission-denied', 'That is not your work.');
  } else {
    await requireCourseScope(req, cw.courseId);
    if (studentUid === null) file = cw.files[fileId];
    else file = findWorkFile((await subRef(studentUid, cwId).get()).data() as SubmissionDoc | undefined, undefined, fileId);
  }
  if (!file) throw new HttpsError('not-found', 'That file is not available.');
  const link = await signGet(file.storageKey, READ_URL_TTL_MS);
  return { url: link.url, expiresAt: link.expiresAt, name: file.name, contentType: file.contentType };
}, MEDIA_READ_SECRETS);

// ----------------------------------------------------------------- sweep --

/** Clear attachments started more than a day ago and never confirmed. */
export async function sweepAttachmentUploads(now: number): Promise<number> {
  const stale = await db()
    .collection(COLLECTIONS.attachmentUploads)
    .where('startedAt', '<', now - ABANDONED_AFTER_MS)
    .get();
  for (const doc of stale.docs) {
    await deleteObject((doc.data() as AttachmentUploadDoc).storageKey);
    await doc.ref.delete();
  }
  return stale.size;
}
