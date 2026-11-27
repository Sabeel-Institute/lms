import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, auditIds, type AuditEntryDoc, type AuditId, type Role } from '@sabeel/shared';
import { assertAccountLive } from './guards';
import { nameAuditIds } from './auditNames';
import { SENTRY_DSN, type CallableRuntime, type Secret } from './reported';
import { reportError } from './sentry';

/**
 * Mutable context the handler enriches so the audit entry is meaningful:
 *  - `courseId`: set it to the class this action belongs to, so a manager can
 *    read the entry. The handler already has it (it loaded the class/recording
 *    to check scope). Left null → the entry is admin-only.
 *  - `detail`: semantic extra (an override reason, a status change). Keys whose
 *    value is undefined are dropped before the write, so a handler may report a
 *    partial change as `{ a: input.a, b: input.b }` without checking which the
 *    caller actually sent.
 *  - `targets`: the ids touched; if the handler leaves it empty, the wrapper
 *    derives ids from the request data.
 */
export interface AuditContext {
  courseId: string | null;
  targets: Record<string, string>;
  detail?: Record<string, unknown>;
  /**
   * The call changed nothing — a removal of a student already removed, an
   * override already gone — so no row is written. The log is a record of what
   * happened, and a second "Removed from Hikam" for one removal is not a thing
   * that happened; the student's page reads these rows as their history.
   */
  noop?: boolean;
}

/*
 * The id fields a callable's payload may carry, picked up automatically so most
 * callables need not set `audit.targets` at all.
 *
 * `sessionId` was missing, and it is the one an irreversible act names:
 * `deleteSession({ sessionId })` derived `{}`, so the log recorded that a
 * session — and its recording, its whole ledger and the class's attendance for
 * that day — had been destroyed, without saying which. `updateSession` was the
 * same, on the call that reopens a closed recording by moving its due date.
 *
 * `deriveTargets`'s tests in `functions/test/unit/audited.test.ts` hold each of
 * these payload shapes to naming something.
 */
const ID_KEYS = [
  'recordingId',
  'sessionId',
  'studentUid',
  'cohortId',
  'courseId',
  'courseworkId',
  'uid',
] as const;

export function deriveTargets(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const d = (data ?? {}) as Record<string, unknown>;
  for (const k of ID_KEYS) if (typeof d[k] === 'string' && d[k]) out[k] = d[k] as string;
  return out;
}

/**
 * The ids a request names, for naming before the change runs: the ids
 * `deriveTargets` finds, and a recording's file (`itemId`, alone or inside an
 * `edit`), which a removal takes out of the recording.
 */
function requestIds(data: unknown): AuditId[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const edit = (d.edit ?? {}) as Record<string, unknown>;
  const itemId = typeof d.itemId === 'string' ? d.itemId : typeof edit.itemId === 'string' ? edit.itemId : undefined;
  return auditIds({ targets: deriveTargets(data), detail: itemId ? { itemId } : {} });
}

/** `nameAuditIds`, never failing the call: an entry without names still records the change. */
async function names(action: string, ids: AuditId[]): Promise<Record<string, string>> {
  try {
    return await nameAuditIds(ids);
  } catch (e) {
    await reportError(e, { source: `auditNames:${action}` });
    return {};
  }
}

/** Append an audit entry. Used by the wrapper and directly by the auth trigger. */
export async function writeAudit(entry: AuditEntryDoc): Promise<void> {
  await getFirestore().collection(COLLECTIONS.auditLog).add(entry);
}

/**
 * Drop keys whose value is `undefined`, and return undefined if nothing is left.
 *
 * Firestore rejects an `undefined` field value outright. A handler that reports
 * a partial change (`{ role, status }` when only the role moved) would therefore
 * lose the ENTIRE entry — silently, because the audit write is best-effort. The
 * missing key already says "unchanged"; the undefined value adds nothing.
 */
export function pruneDetail(detail: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A mutating callable that ALSO records one audit entry per successful call.
 *
 * Same `SENTRY_DSN` binding and error reporting as `reportedCall` — reads
 * (`getPlaybackUrl`) keep using that. The audit write is best-effort: it happens
 * AFTER the mutation succeeded, so if it fails the user's action must not be
 * undone or reported as failed — the failure is sent to Sentry and the result is
 * still returned. "Every change is audited" is a property of this wrapper, not a
 * discipline repeated in 16 callables.
 */
export function auditedCall<T>(
  action: string,
  handler: (req: CallableRequest, audit: AuditContext) => Promise<T>,
  extraSecrets: Secret[] = [],
  runtime: CallableRuntime = {},
) {
  return onCall({ secrets: [SENTRY_DSN, ...extraSecrets], ...runtime }, async (req) => {
    const audit: AuditContext = { courseId: null, targets: {} };
    let result: T;
    let before: Record<string, string> = {};
    try {
      // The account, not just the token — see `assertAccountLive`.
      await assertAccountLive(req);
      // NAMED BEFORE THE CHANGE, so an entry about a deletion still says what
      // was deleted: what the request names, read while it still exists.
      before = await names(action, requestIds(req.data));
      result = await handler(req, audit);
    } catch (e) {
      if (!(e instanceof HttpsError)) await reportError(e, { source: action });
      throw e;
    }

    if (audit.noop) return result;
    try {
      const token = (req.auth?.token ?? {}) as { role?: Role };
      const detail = audit.detail ? pruneDetail(audit.detail) : undefined;
      const targets = Object.keys(audit.targets).length ? audit.targets : deriveTargets(req.data);
      // And AFTER, for what the change created; a name read before wins.
      const ids = auditIds({ courseId: audit.courseId, targets, detail });
      const after = await names(action, ids.filter((i) => !(i.id in before)));
      const named = Object.fromEntries(
        ids.flatMap((i) => (before[i.id] ?? after[i.id] ? [[i.id, before[i.id] ?? after[i.id]]] : [])),
      );
      await writeAudit({
        at: Date.now(),
        actorUid: req.auth?.uid ?? 'unknown',
        actorRole: token.role ?? 'system',
        action,
        courseId: audit.courseId,
        targets,
        ...(detail ? { detail } : {}),
        ...(Object.keys(named).length ? { names: named } : {}),
      });
    } catch (e) {
      // Never fail (or undo) a completed mutation because the audit write did.
      await reportError(e, { source: `audit:${action}` });
    }
    return result;
  });
}
