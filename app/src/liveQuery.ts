// The ONE way to subscribe to live Firestore data from a hook. Every live hook
// in the app goes through here — never hand-roll onSnapshot state in a hook.
//
// Invariants (born of a real bug in the sibling time-tracker — its
// docs/POSTMORTEM-2026-07-16-stale-week.md; inherited here, not re-learned):
//  1. State RESETS to `empty` the moment the subscription inputs change. React
//     state otherwise persists across dependency changes, so query A's results
//     would stay on screen while query B's first snapshot is in flight — on a
//     slow connection that showed one week's entries under another week.
//  2. Listener errors also reset to `empty`: an empty screen plus a console
//     warning beats silently-wrong data that never corrects itself.
import { useEffect, useRef, useState } from 'react';
import {
  onSnapshot,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
} from 'firebase/firestore';
import { captureError } from './sentry';

// ---- Listener-error visibility -------------------------------------------
// A server-rejected listen (a missing index, a rules denial) otherwise dies as
// a console.warn nobody sees on a phone. Screens surface the latest live-data
// error via useListenerError.
//
// KEYED BY LABEL, AND DROPPED WHEN THE SUBSCRIPTION GOES AWAY. A single sticky
// string cleared only by a later success from the same label outlives the screen
// that produced it: nothing else in the app subscribes under that label, so the
// banner follows the user onto every screen afterwards and never clears. That
// shipped — a denial on the recording ledger was read as "the upload is broken"
// because the red message was still there on the session screen.
//
// The live set answers the honest question instead: is anything subscribed RIGHT
// NOW failing? An entry leaves on success or when its listener is torn down
// (both via forgetListener), so navigating away from the broken screen clears it
// and returning brings it back.
const errorWatchers = new Set<(msg: string | null) => void>();
const listenerErrors = new Map<string, string>();
let lastListenerError: string | null = null;

/**
 * Registry key: one entry per SUBSCRIPTION, not per label.
 *
 * A label is not unique — the library mounts a `courseRecordings` listener for
 * every course a manager teaches. Keyed by label alone, the one that succeeds
 * erases the one that was denied, and the screen goes quiet while a section is
 * still empty. `scope` is exactly the disambiguator the Sentry tag carries, so
 * the two stay in step by construction.
 */
function subscriptionKey(label: string, context?: Record<string, string>): string {
  return context?.scope ? `${label}:${context.scope}` : label;
}

/**
 * Recompute the surfaced message and notify every watcher.
 *
 * UNCONDITIONALLY, even when the message is unchanged. Two different questions
 * ride this one channel: `useListenerError` wants the aggregate MESSAGE, and
 * `useListenerFailed` wants to know whether ITS labels are in the map. Skipping
 * the notification when the message happened not to change left the second one
 * stuck — a subscription that recovered while some unrelated listener was still
 * failing never told anyone, so a screen went on saying it could not read its
 * data over the rows it had just loaded. `useListenerError`'s own setState
 * bails on an identical string, so notifying always costs nothing.
 */
function publishListenerError(): void {
  // Most recently recorded failure wins — the one the user just provoked.
  const next = [...listenerErrors.values()].pop() ?? null;
  lastListenerError = next;
  errorWatchers.forEach((w) => w(next));
}

/**
 * This subscription is healthy or gone — retire any banner it raised.
 *
 * One function for both because they are the same fact: the error described a
 * live subscription, and it no longer describes anything.
 */
function forgetListener(key: string) {
  if (listenerErrors.delete(key)) publishListenerError();
}

/**
 * Whether there is an account behind these subscriptions that may read anything.
 *
 * Signing out does not tear the listeners down first. Firestore re-issues every
 * live listen the moment the credential drops, and the server refuses them —
 * while React is still unmounting the screen that owns them. So the last thing
 * a student does before leaving raises a permission denial from their own home
 * screen, which is where the Sign out button is. It reached Sentry as a defect.
 *
 * It is not one: with no usable session, EVERY rule denies by design, so a
 * denial in that state carries no information. Set from the auth session (see
 * session.ts) — its `onAuthStateChanged` callback runs in the same tick the
 * credential drops, well before the server's refusal can come back over the
 * wire, so the flag is always already false by the time this is consulted.
 *
 * Narrow on purpose. It suppresses ONLY permission errors, and only while the
 * app knows the account cannot read: a denial to a signed-in, active user is
 * the interesting kind and still reports.
 */
let sessionCanRead = false;

/** Called by the auth session whenever the account's readability changes. */
export function setLiveDataSession(canRead: boolean): void {
  sessionCanRead = canRead;
}

function reportListenerError(
  key: string,
  label: string,
  e: { code?: string; message: string },
  context?: Record<string, string>,
  extra?: Record<string, unknown>,
) {
  const code = e.code ?? '';
  if (!sessionCanRead && (code === 'permission-denied' || code === 'unauthenticated')) {
    // Still logged, and marked — the e2e counts unmarked listener warnings and
    // must not be blinded by this, but neither should it fail on a denial we
    // deliberately expect.
    console.warn(`${label} listener`, code, '(session ended — expected)');
    return;
  }
  const message = `Live data error (${label}): ${e.code ?? e.message}`;
  // Re-insert so this one is the most recent entry, not merely present.
  listenerErrors.delete(key);
  listenerErrors.set(key, message);
  publishListenerError();
  console.warn(`${label} listener`, e.code ?? e.message);
  // Off-device visibility: a listener failure in a phone console is invisible.
  //
  // REPORT OUR MESSAGE, NOT FIRESTORE'S. Handing Sentry the raw FirebaseError
  // groups every listener in the app into one issue titled "Missing or
  // insufficient permissions", over a stack of minified SDK internals that names
  // no screen and no collection — an issue that cannot be acted on without
  // guessing which of two dozen subscriptions produced it. The label is the
  // whole diagnostic, so it belongs in the title; the code and the original
  // message ride along, and the SDK frames were never worth reading.
  captureError(
    new Error(message),
    {
      source: label,
      code: e.code ?? 'none',
      detail: e.message,
      // `scope` names WHICH subscription of this label failed. A label alone is
      // ambiguous wherever a screen mounts one listener per row — the library
      // runs a `courseRecordings` listener per course a manager teaches, so a
      // denial there says a course is unreadable without saying which one, and
      // the event cannot be chased any further. Set it wherever the label is
      // not unique.
      ...(context ?? {}),
    },
    {
      // What the listener was asking for — the queue's `in` scope, say — which
      // a tag cannot hold (200 characters) and a triage cannot do without:
      // WEB-4 was three days of guessing which course a manager's stale cache
      // still named.
      ...(extra ?? {}),
      // GROUPED BY LISTENER AND CODE, not by the frame that reports them all.
      // Every listener failure in the app is thrown from this one line, so
      // Sentry's default fingerprint filed a student's refused recording, a
      // manager's refused queue and an admin's refused people list as one
      // issue, and the three incidents in it had three different causes.
      fingerprint: ['listener', label, e.code ?? 'none'],
    },
  );
}

/** Latest live-listener failure, app-wide; null when healthy. */
export function useListenerError(): string | null {
  const [err, setErr] = useState(lastListenerError);
  useEffect(() => {
    errorWatchers.add(setErr);
    return () => {
      errorWatchers.delete(setErr);
    };
  }, []);
  return err;
}

/**
 * Are THESE subscriptions failing right now?
 *
 * `useListenerError` answers "is anything in the app failing", which is the
 * right question for the banner every screen shows and the wrong one for a hook
 * deciding what its own data means. A screen that must tell "no snapshot yet"
 * from "refused" cannot use the app-wide signal: another screen's denial would
 * make it claim its own query failed, and its own denial would clear the moment
 * some unrelated listener recovered.
 *
 * Named by label, matching `subscriptionKey` — a label with a `scope` is stored
 * as `label:scope`, so this matches on the label part.
 */
export function useListenerFailed(labels: readonly string[]): boolean {
  const key = labels.join(',');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    const check = () =>
      setFailed(
        [...listenerErrors.keys()].some((k) => wanted.includes(k.split(':')[0])),
      );
    check();
    // The registry changes whenever any listener fails or recovers, and that is
    // exactly when the aggregate is republished.
    errorWatchers.add(check);
    return () => {
      errorWatchers.delete(check);
    };
  }, [key]);
  return failed;
}
// ---------------------------------------------------------------------------

export interface LiveQueryOptions<T> {
  /** Names this subscription in listener errors and in Sentry. */
  label: string;
  map: (snap: QuerySnapshot) => T;
  /** Rendered before the first snapshot, and after an error or an input change. */
  empty: T;
  /**
   * Also re-fire when only metadata changes — specifically when a local write
   * flips from pending to synced. Screens showing a "Pending sync" state need
   * that transition; without it the snapshot fires once with `hasPendingWrites`
   * true and never again when the write lands, so the badge sticks forever. Off
   * by default because it doubles snapshot callbacks and most screens do not care.
   */
  includeMetadataChanges?: boolean;
  /**
   * Extra Sentry tags naming WHICH subscription of this label failed. Required
   * wherever a screen mounts one listener per row and the label alone cannot
   * identify the failing one — see the note in reportListenerError.
   */
  context?: Record<string, string>;
  /**
   * Asked, at the moment of a refusal, whether this one was expected — read
   * fresh each time, so it may depend on state that has moved since the
   * subscription was made. `true` logs the denial as expected and resolves to
   * `empty` without a banner or a Sentry event; anything else, and any error
   * that is not a denial, reports as usual. The work queue uses it: its `in`
   * scope is built from the FIRST courses snapshot, which on a cold load is
   * the cache, and the rules judge every value against live data — so a
   * course the manager no longer runs refuses the whole query until the
   * server's snapshot corrects the scope. That refusal is the cache being
   * stale, not a fault, and it was two Sentry events per cold load.
   */
  expectDenial?: () => boolean;
  /** Extra fields for the Sentry event if this listener fails — what it was
   *  asking for, when the label alone cannot say. */
  extra?: Record<string, unknown>;
}

/**
 * Live query results. `make`/`map` are called fresh per (re)subscription;
 * a null query means "not subscribed" (e.g. role-gated queries) → `empty`.
 *
 * ARGUMENT ORDER IS LOAD-BEARING. `make` first and `deps` second is the only
 * shape `react-hooks/exhaustive-deps` can read (see eslint.config.mjs), and that
 * rule is what mechanically proves every live screen resubscribes when its
 * inputs change. Everything else is options precisely so these two stay in the
 * positions the linter requires — move them and the check goes quiet without
 * failing, which is worse than never having had it.
 */
export function useLiveQuery<T>(
  make: () => Query | null,
  deps: readonly unknown[],
  { label, map, empty, includeMetadataChanges = false, context, expectDenial, extra }: LiveQueryOptions<T>,
): T {
  const [value, setValue] = useState<T>(empty);
  // Read at the refusal, not at the subscription: whether a denial is expected
  // can depend on state that moved after the listener was opened.
  const expectDenialRef = useRef(expectDenial);
  expectDenialRef.current = expectDenial;
  useEffect(() => {
    setValue(empty);
    const q = make();
    if (!q) return;
    const key = subscriptionKey(label, context);
    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges },
      (snap) => {
        setValue(map(snap));
        forgetListener(key);
      },
      (e) => {
        setValue(empty);
        if (e.code === 'permission-denied' && expectDenialRef.current?.()) {
          // Marked, like a denial after sign-out: the e2e counts unmarked
          // listener warnings and must not be blinded, nor fail on this one.
          console.warn(`${label} listener`, e.code, '(provisional scope — expected)');
          return;
        }
        reportListenerError(key, label, e, context, extra);
      },
    );
    return () => {
      unsubscribe();
      forgetListener(key);
    };
    // deps are the caller's subscription inputs; make/map/empty are per-render
    // closures over exactly those inputs.
    //
    // The one place exhaustive-deps is deliberately overridden, and the only
    // one that should ever be: this hook's contract IS a caller-supplied dep
    // list, so the rule cannot see what it needs to. Obeying it here would mean
    // adding make/map/empty — all rebuilt on every render — which tears down and
    // re-establishes the Firestore listener on every render of every live
    // screen. Callers get no exemption: their `deps` argument must still list
    // every input `make` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

export interface LiveDocOptions<T> {
  label: string;
  map: (snap: DocumentSnapshot) => T;
  /** Rendered before the first snapshot, on an error, and when the doc is absent. */
  empty: T;
  /**
   * Extra Sentry tags naming WHICH subscription of this label failed. Required
   * wherever a screen mounts one listener per row and the label alone cannot
   * identify the failing one — see the note in reportListenerError.
   */
  context?: Record<string, string>;
  /**
   * A refusal is an ordinary answer for this reader, not a defect: the
   * document exists and the rules withhold it from them by design. A student's
   * recording is the case — unpublished or archived while they have it open,
   * the rules close it and the listener is refused, which is the app working.
   * Reported, that refusal painted "Live data error: permission-denied" over
   * the "it may have been removed" screen and filed two Sentry events per
   * unpublish. With this set a denial resolves to `empty` and is logged as
   * expected; any other error still reports.
   */
  denialIsAnswer?: boolean;
}

/**
 * One document, live — the single-document counterpart of useLiveQuery, with the
 * same reset-on-input-change and reset-on-error invariants.
 *
 * A DOCUMENT listener, not `where('__name__','==',id)`: the latter is a `list`,
 * and students are granted `get` on a course they are enrolled in and never
 * `list`. So this is the only way a student screen can hold a live course — and
 * a one-shot getDoc would leave the archived and archived-listening flags frozen
 * at mount, which decide whether the "recordings are closed" notice shows and whether
 * the player enables its transport.
 *
 * `resolved` says whether the listener has answered. `empty` alone cannot tell
 * "still loading" from "there is no such document", and that difference became
 * visible the moment screens started resolving their subjects from a URL: a link
 * to something deleted, or a recording unpublished while a student had the
 * player open, would otherwise sit on a spinner for ever. It stays false while
 * the ref is null — "not subscribed", which for a chained read (recording → its
 * course) means still waiting on the step before it, not an answer.
 *
 * Argument order matches useLiveQuery, and for the same reason: `make` at 0 and
 * `deps` at 1 is what lets react-hooks/exhaustive-deps check the dependencies.
 */
export function useLiveDocState<T>(
  make: () => DocumentReference | null,
  deps: readonly unknown[],
  { label, map, empty, context, denialIsAnswer }: LiveDocOptions<T>,
): { value: T; resolved: boolean } {
  const [state, setState] = useState<{ value: T; resolved: boolean }>({
    value: empty,
    resolved: false,
  });
  useEffect(() => {
    setState({ value: empty, resolved: false });
    const ref = make();
    if (!ref) return;
    const key = subscriptionKey(label, context);
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        setState({ value: snap.exists() ? map(snap) : empty, resolved: true });
        forgetListener(key);
      },
      (e) => {
        // A denial is an answer too: the caller may not read it, and telling
        // them it is unavailable beats a spinner that never stops.
        setState({ value: empty, resolved: true });
        if (denialIsAnswer && e.code === 'permission-denied') {
          // Marked, like a denial after sign-out: the e2e counts unmarked
          // listener warnings and must not be blinded, nor fail on this one.
          console.warn(`${label} listener`, e.code, '(withheld by the rules — expected)');
          return;
        }
        reportListenerError(key, label, e, context);
      },
    );
    return () => {
      unsubscribe();
      forgetListener(key);
    };
    // Same caller-supplied-deps contract as useLiveQuery; see the note there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

