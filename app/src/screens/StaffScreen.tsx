import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Role } from '@sabeel/shared';
import {
  Button,
  Card,
  Collapsible,
  ConfirmDanger,
  EmailText,
  Empty,
  Grid,
  IconButton,
  ListRow,
  Notice,
  Row,
  Screen,
  SectionTitle,
} from '../components/ui';
import { Sheet, SheetOption } from '../components/Sheet';
import { setStaffAccess, useDecidedStaffState, usePendingStaffState, type StaffRow } from '../staff';
import { deleteAccount } from '../accounts';
import { useOneAtATime } from '../oneAtATime';

const NO_STAFF: StaffRow[] = [];
import { getTheme } from '../theme';
import { errorText } from '../errors';

const t = getTheme();

/**
 * Admin-only: the approval queue and the running access list.
 *
 * Everything here goes through the setStaffAccess callable, which re-checks that
 * the caller is an admin. The UI hiding a control is convenience, never the
 * boundary.
 */
export function StaffScreen({ selfUid, header }: { selfUid: string; header?: ReactNode }) {
  // The `State` variants: "Nobody is waiting" and "No staff accounts yet" are
  // answers, and an admin read both for the length of every cold load.
  const pendingState = usePendingStaffState(true);
  const decidedState = useDecidedStaffState(true);
  const pending = pendingState ?? NO_STAFF;
  const decided = decidedState ?? NO_STAFF;
  // Split the way the student list is split: a disabled account is history,
  // not a colleague, and interleaved with the live ones it read as one.
  const active = decided.filter((s) => s.status === 'active');
  const disabled = decided.filter((s) => s.status === 'disabled');
  const deleted = decided.filter((s) => s.status === 'deleted');
  const { active: deleting, run: once } = useOneAtATime();
  const remove = (uid: string) => once(`delete-${uid}`, () => deleteAccount(uid));
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * A CARD STAYS LOCKED UNTIL THE SNAPSHOT AGREES, not until the callable
   * answers — the same shape as the enrol row on a course. `busyUid` clears
   * on the response, and the row is still drawn from the previous snapshot
   * for a moment: a pending card still offers both approvals, so a second
   * tap on "Approve as admin" after "Approve as manager" had already returned
   * sent `role: 'admin'` and won; a staff card still shows the old label and
   * re-sends it. The lock holds what was asked for and lifts when the live
   * row says the same.
   */
  const [settling, setSettling] = useState<ReadonlyMap<string, Parameters<typeof setStaffAccess>[0]>>(
    () => new Map(),
  );
  useEffect(() => {
    setSettling((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const [uid, want] of prev) {
        const row = decided.find((r) => r.uid === uid);
        const stillPending = pending.some((r) => r.uid === uid);
        const agrees =
          !stillPending &&
          (row === undefined ||
            ((want.role === undefined || row.role === want.role) &&
              (want.status === undefined || row.status === want.status)));
        if (agrees) next.delete(uid);
      }
      return next.size === prev.size ? prev : next;
    });
    // `settling` too: the snapshot can land BEFORE the callable's response
    // does, so the lock may be set after the row already agrees — and with
    // only the rows as dependencies nothing would run again to lift it.
  }, [pending, decided, settling]);
  const locked = (uid: string) => busyUid === uid || settling.has(uid);

  const act = async (uid: string, change: Parameters<typeof setStaffAccess>[0]) => {
    if (locked(uid)) return;
    setBusyUid(uid);
    setError(null);
    // Locked from the tap, as the enrol row is, and released on failure only:
    // on success the snapshot releases it, whichever of the two lands first.
    setSettling((prev) => new Map(prev).set(uid, change));
    try {
      await setStaffAccess(change);
    } catch (e) {
      setError(errorText(e));
      setSettling((prev) => {
        const next = new Map(prev);
        next.delete(uid);
        return next;
      });
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <Screen title="People" subtitle="Approve accounts and set roles" width="list">
      {header}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <SectionTitle>Waiting for approval{pendingState === null ? '' : ` (${pending.length})`}</SectionTitle>
      {pendingState === null ? (
        <Empty>Checking…</Empty>
      ) : pending.length === 0 ? (
        <Empty>Nobody is waiting.</Empty>
      ) : (
        <Grid min={330}>
          {pending.map((s) => (
            <Card key={s.uid}>
              <Person row={s} />
              <Row>
                <Button
                  testID={`approve-${s.email}`}
                  label="Approve as manager"
                  busy={locked(s.uid)}
                  onPress={() => void act(s.uid, { uid: s.uid, status: 'active', role: 'manager' })}
                />
                <Button
                  label="Approve as admin"
                  variant="secondary"
                  busy={locked(s.uid)}
                  onPress={() => void act(s.uid, { uid: s.uid, status: 'active', role: 'admin' })}
                />
              </Row>
            </Card>
          ))}
        </Grid>
      )}

      <SectionTitle>Staff{decidedState === null ? '' : ` (${active.length})`}</SectionTitle>
      {decidedState === null ? (
        <Empty>Checking…</Empty>
      ) : active.length === 0 ? (
        <Empty>No staff accounts yet.</Empty>
      ) : (
        <Grid min={330} rows>
          {active.map((s) => (
            <StaffRowItem key={s.uid} row={s} isSelf={s.uid === selfUid} busy={locked(s.uid)} act={act} />
          ))}
        </Grid>
      )}

      {/* Out of the way but reachable, exactly as a disabled student is: the
          row keeps its menu, so bringing a colleague back is one menu away once
          the section is open. */}
      {disabled.length > 0 ? (
        <Collapsible testID="staff-disabled" title="Disabled" count={disabled.length}>
          <Grid min={330} rows>
            {disabled.map((s) => (
              <StaffRowItem
                key={s.uid}
                row={s}
                isSelf={s.uid === selfUid}
                busy={locked(s.uid) || deleting === `delete-${s.uid}`}
                act={act}
                remove={remove}
              />
            ))}
          </Grid>
        </Collapsible>
      ) : null}

      {/* Names only, and nothing to do: the account is gone, and what they did
          stays in the history under their name. */}
      {deleted.length > 0 ? (
        <Collapsible testID="staff-deleted" title="Deleted" count={deleted.length}>
          <Grid min={330} rows>
            {deleted.map((s) => (
              <ListRow key={s.uid} testID={`staff-deleted-${s.uid}`} name={s.displayName} />
            ))}
          </Grid>
        </Collapsible>
      ) : null}
    </Screen>
  );
}

/**
 * One colleague: name, address and role, and a ⋮ that holds what can be
 * changed. Two buttons on every row made the list a wall of Make admin and
 * Disable, and the one person whose row has neither — you — read as broken.
 */
function StaffRowItem({
  row: s,
  isSelf,
  busy,
  act,
  remove,
}: {
  row: StaffRow;
  isSelf: boolean;
  busy: boolean;
  act: (uid: string, change: Parameters<typeof setStaffAccess>[0]) => Promise<void>;
  /** Delete the account; offered on a disabled colleague's row only. */
  remove?: (uid: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Said on the row, under the confirm still open: the notice at the top of
  // the page is a screen away from the Disabled section at the bottom.
  const [failed, setFailed] = useState<string | null>(null);
  const choose = (change: Parameters<typeof setStaffAccess>[0]) => {
    setOpen(false);
    void act(s.uid, change);
  };
  return (
    <>
      <ConfirmDanger
        enabled={remove !== undefined && s.status === 'disabled'}
        opened={{ open: confirmDelete, close: () => setConfirmDelete(false) }}
        label="Delete account"
        confirmLabel="Delete account"
        warning={`Delete ${s.displayName}’s account for good? They can no longer sign in, their email address and notification settings are removed, and they stop managing their courses. Their name stays in the history with everything they did. This cannot be undone.`}
        busy={busy}
        confirmTestID={`staff-delete-confirm-${s.uid}`}
        onConfirm={() => {
          setFailed(null);
          void remove?.(s.uid).then(
            () => setConfirmDelete(false),
            (e: unknown) => setFailed(errorText(e)),
          );
        }}
      >
        <ListRow
          name={isSelf ? `${s.displayName} (you)` : s.displayName}
          detail={<EmailText email={s.email} suffix={` · ${s.role}`} />}
          actionsPinned
          actions={
            // None on your own row. The server refuses it too; without the rule,
            // the last admin could lock the institute out of its own user
            // management.
            isSelf ? undefined : (
              <IconButton
                testID={`staff-actions-${s.email}`}
                icon="more-vert"
                bare
                busy={busy}
                label={`Change ${s.displayName}'s access`}
                onPress={() => setOpen(true)}
              />
            )
          }
        />
        <Sheet visible={open} title={s.displayName} onClose={() => setOpen(false)} closeAt="corner">
          <SheetOption
            testID={`staff-role-${s.email}`}
            label={s.role === 'admin' ? 'Make manager' : 'Make admin'}
            detail={
              s.role === 'admin'
                ? 'Sees only the courses they are given.'
                : 'Manages staff, cohorts and every course.'
            }
            onPress={() =>
              choose({ uid: s.uid, role: (s.role === 'admin' ? 'manager' : 'admin') as Extract<Role, 'admin' | 'manager'> })
            }
          />
          {/* The normal tone in BOTH directions, exactly as on a student's page.
              Disabling an account is reversible and is the RECOMMENDED action in
              this product; dressing it as destructive teaches people the colour
              means nothing. */}
          <SheetOption
            testID={`staff-access-${s.email}`}
            label={s.status === 'disabled' ? 'Re-enable' : 'Disable'}
            detail={s.status === 'disabled' ? 'They can sign in again.' : 'They can no longer sign in. You can re-enable them.'}
            onPress={() => choose({ uid: s.uid, status: s.status === 'disabled' ? 'active' : 'disabled' })}
          />
          {remove !== undefined && s.status === 'disabled' ? (
            <SheetOption
              testID={`staff-delete-${s.uid}`}
              label="Delete account"
              detail="For a request to delete their data. Their history stays."
              tone="danger"
              onPress={() => {
                setOpen(false);
                setConfirmDelete(true);
              }}
            />
          ) : null}
        </Sheet>
      </ConfirmDanger>
      {failed ? <Notice tone="error">{failed}</Notice> : null}
    </>
  );
}

/** A waiting account: who is asking. Its section says it is waiting. */
function Person({ row }: { row: StaffRow }) {
  return (
    <View style={styles.person}>
      <Text style={styles.name}>{row.displayName}</Text>
      <EmailText email={row.email} />
    </View>
  );
}

const styles = StyleSheet.create({
  person: { gap: 2 },
  name: { fontSize: 16, fontWeight: '600', color: t.text.primary },
});
