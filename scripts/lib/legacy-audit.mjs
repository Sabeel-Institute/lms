/**
 * An audit entry from the live app, renamed to the action this app writes for
 * the same thing — on Firestore REST documents, which is how the switchover
 * seed copies them.
 *
 * The live app (v0.7.1, in maintenance) writes two actions under names this
 * app has since replaced; every other action it writes, this app writes under
 * the same name. Copied as they are, those two would print as function names
 * on the audit screen, which has words only for the actions written today
 * (`AUDIT_ACTION_LABELS`), and `check:documents` would fail on them. The same
 * map renamed this project's own copy in place on 2026-10-14.
 */

/** The live app's name for an action → this app's name for it. */
export const RENAMED_AUDIT_ACTIONS = Object.freeze({
  clearRecordingAudio: 'removeRecordingMedia',
  importZoomRecording: 'importZoomFiles',
});

/** Today's name for a retired action, or null when the name is current. */
const renamedAction = (action) =>
  Object.hasOwn(RENAMED_AUDIT_ACTIONS, action) ? RENAMED_AUDIT_ACTIONS[action] : null;

/**
 * The REST `fields` of one audit entry with its action renamed, if the live
 * app's name for it is retired. Nothing else is touched: who, when, what to,
 * and the detail are the record.
 */
export function convertAuditEntry(fields) {
  const renamed = renamedAction(fields.action?.stringValue);
  return renamed ? { ...fields, action: { stringValue: renamed } } : fields;
}
