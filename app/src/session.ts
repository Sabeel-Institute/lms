import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { closePlayback, forgetPlaybackUrls } from './playback';
import { doc, getDoc, onSnapshot, waitForPendingWrites } from 'firebase/firestore';
import {
  COLLECTIONS,
  isStaffRole,
  type Role,
  type StaffUserDoc,
  type StudentDoc,
  type TokenClaims,
} from '@sabeel/shared';
import { googleSignOut } from './auth/google';
import { auth, db } from './firebase';
import { afterSignOut } from './firestoreInit';
import { forgetEveryAnswer } from './answerJournal';
import { flushEveryAutosave } from './autosave';
import { sessionEndedIt, setLiveDataSession } from './liveQuery';
import { createPollChain } from './pollChain';
import { registerThisDevice, unregisterThisDevice } from './notifications';
import { setSentryRole } from './sentry';

export type Profile =
  | { kind: 'staff'; doc: StaffUserDoc }
  | { kind: 'student'; doc: StudentDoc };

/** Why the last session ended, when the person has to be told: see `useSession`. */
export type SessionEnd = 'refused' | 'disabled';

export type Session =
  | { phase: 'loading' }
  | { phase: 'signedOut'; ended: SessionEnd | null }
  | { phase: 'signedIn'; user: User; profile: Profile | null; claims: TokenClaims };

/** How long sign-out waits for the final progress write before giving up. */
const SIGN_OUT_WRITE_GRACE_MS = 1000;
/** How long it waits for everything else still being sent, before keeping it instead. */
const SIGN_OUT_DRAIN_MS = 2000;

export async function signOut(): Promise<void> {
  // Stop the audio before anything else. Playback outlives the screen that
  // started it now, so nothing else would end it: signing out would drop the
  // credential, leave a foreground service holding a lecture, and give the next
  // person on a shared device someone else's recording still playing.
  //
  // AWAITED, for the last progress write it carries — but only briefly.
  // Dropping the credential first means that write is refused and the final
  // minutes of listening, the ones somebody would argue about, are lost at
  // exactly the moment a student stops listening.
  //
  // BOUNDED, because the promise is the tail of a serialised write chain and
  // Firestore does not settle a write until the backend acknowledges it. On a
  // phone with no signal that is never: the button would hang, the push
  // registration would never be dropped, and the person would stay signed in on
  // a shared device — the case this whole function exists to protect. A second
  // is long enough for a write on a working connection and short enough that
  // nobody waits on a broken one.
  await Promise.race([
    closePlayback().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WRITE_GRACE_MS)),
  ]);
  // The signed-URL cache outlives a credential otherwise: a 12-hour URL minted
  // for one account would still be handed to the next person on a shared
  // device, bypassing `getPlaybackUrl`'s entitlement check entirely.
  forgetPlaybackUrls();
  // An answer or a grade still waiting out its autosave delay is sent first,
  // or it would be sent after the credential had gone, and refused.
  await Promise.race([flushEveryAutosave(), new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WRITE_GRACE_MS))]);
  // Whatever is still being sent goes now, while the credential that sends it
  // exists; the cache is cleared after only if nothing is left (`afterSignOut`).
  const drained = await Promise.race([
    waitForPendingWrites(db).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGN_OUT_DRAIN_MS)),
  ]);
  // Drop this device's push registration FIRST, while the credential still
  // exists to authorize the delete. A shared device that kept its registration
  // would deliver one student's "a recording is ready" to whoever signs in
  // next — a leak, and the single most confusing notification the app could
  // send. Best-effort: failing to unregister must never trap someone signed in.
  const uid = auth.currentUser?.uid;
  if (uid) await unregisterThisDevice(uid).catch(() => undefined);
  // Also clear the native Google session, or the next sign-in silently reuses
  // the same account with no way to switch users.
  await googleSignOut().catch(() => undefined);
  await fbSignOut(auth);
  // The web app may end Firestore next (`afterSignOut`), under any listener
  // still attached. Reads are marked as ended, so those endings are expected,
  // and the auth observer gets a turn to detach the profile listener first.
  setLiveDataSession(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await afterSignOut(db, drained);
  // The answers kept on this device go with the cache, and only when it does:
  // anything not sent stays where it can still be sent from.
  if (drained) await forgetEveryAnswer();
}

/**
 * The profile listener's errors, marked expected when the session ended it as
 * `liveQuery` marks its own: Try again ends Firestore under it while signed
 * in (`reloadFromServer`).
 */
function profileListenerError(e: { code?: string; message: string }) {
  if (sessionEndedIt(e.code ?? '')) console.warn('profile listener', e.code, '(session ended — expected)');
  else console.warn('profile listener', e.code ?? e.message);
}

/** Which collection holds this user's mirror document. */
function profileCollection(role: Role | undefined): string {
  return isStaffRole(role) ? COLLECTIONS.staffUsers : COLLECTIONS.students;
}

/**
 * Whose device registration has been claimed this run.
 *
 * The session publishes repeatedly — the approval poll, a claim refresh, any
 * profile edit — and re-registering on each would rewrite the same document for
 * no reason. Cleared on sign-out, below.
 */
let pushRegisteredFor: string | null = null;

/** Do the token and the document disagree? One of them is behind the other. */
function isStale(claims: TokenClaims, profile: Profile): boolean {
  return claims.status !== profile.doc.status || claims.role !== profile.doc.role;
}

/**
 * True once the account is approved and usable — the only state that leaves
 * the gate. The token AND the document must say so: the rules ask a staff
 * member's record as well as their token, and an approval writes the claims a
 * moment before the record, so in between every staff read is refused.
 */
export function isReady(claims: TokenClaims, profile: Profile | null): boolean {
  return !!profile && claims.status === 'active' && !isStale(claims, profile);
}

/**
 * Auth state + mirror document + token claims, kept coherent.
 *
 * The mirror document is watched live, AND while the user is gated we also POLL:
 * force-refresh the token and re-read the document every few seconds.
 *
 * THE POLL IS NOT REDUNDANT. When an admin approves someone, the Admin SDK sets
 * that user's custom claims, which disrupts their in-flight Firestore listener —
 * so the document-update snapshot may never arrive. Polling detects approval
 * regardless, and is also how the token picks up new claims without a
 * sign-out/in. Remove it and approval appears to do nothing until the user
 * restarts the app.
 *
 * Which collection to read is itself derived from the claim, because the two
 * populations live in different collections and a student must never be made to
 * read staffUsers (the rules would deny it, producing a listener error on every
 * student sign-in).
 */
export function useSession(): Session {
  const [session, setSession] = useState<Session>({ phase: 'loading' });

  useEffect(() => {
    let unsubDoc: (() => void) | null = null;
    let cancelled = false;
    /*
     * WHICH SIGN-IN THE WORK IN FLIGHT BELONGS TO.
     *
     * Every path into `publish` is asynchronous — the poll force-refreshes a
     * token and reads a document, the listener awaits `getIdTokenResult` — and
     * the credential can drop while they are in the air. `cancelled` does not
     * cover that: it is the effect's cleanup, and this hook lives in `App`, so
     * it is never true in a running app.
     *
     * The consequence was a session that could not be left. Sign out from a
     * gate screen with a poll tick in flight, and its continuation published
     * `signedIn` over the sign-in screen and re-armed the three-second timer;
     * the ticks after it read Firestore with no credential and threw into the
     * catch, so nothing ever corrected it. Pressing Sign out again did nothing,
     * because `auth.currentUser` was already null and the observer never fired.
     * The only way out was killing the app — from the screen that tells people
     * to sign out and try again.
     *
     * Same counter as `playback.ts` uses for the same reason: work started for
     * one owner must not land on the next. The poll chain holds it: each
     * sign-in claims a generation, `publish` checks it, and a tick from an
     * earlier sign-in is never allowed to re-arm (`pollChain.ts`).
     */
    const chain = createPollChain();
    /*
     * REFUSED AT THE DOOR: the account went before it was ever provisioned.
     *
     * The auth trigger deletes a Google account outside the staff domain
     * moments after it is created. When that lands inside the sign-in, the
     * sign-in itself fails and its screen says why (`signInMessage`). Usually
     * it lands just after: the person is signed in, waiting on the
     * provisioning screen, when the poll's forced refresh finds the account
     * gone and the SDK signs them out. That ending used to say nothing at all.
     *
     * Only an account that never had a role: staff and students are given one
     * before they can do anything, so for them the same error is a revoked
     * session, not a refusal, and the message would be false.
     */
    let ended: SessionEnd | null = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      const gen = chain.claim();
      unsubDoc?.();
      unsubDoc = null;
      // FIRST, before anything awaits. Firestore reacts to the same credential
      // change by re-issuing every live listen, and the refusals come back while
      // the screens holding them are still mounted; this is what marks those
      // denials expected rather than reporting them. Publishing it here means it
      // is set in the same tick the credential drops.
      setLiveDataSession(false);

      if (!user) {
        pushRegisteredFor = null;
        setSentryRole(null);
        // NOT ONLY `signOut()`. Playback is a module-level session now, so
        // nothing unmounts it — and this branch is every INVOLUNTARY end: a
        // disabled account whose refresh token is rejected, a sign-out in
        // another tab, a deleted account. Without this the foreground service
        // kept streaming a lecture with the app showing the sign-in screen and
        // no control anywhere to stop it, and a 12-hour signed URL — bound to a
        // recording, not to an account — stayed in the cache for whoever signed
        // in next. Fire and forget: the final write is refused once the
        // credential is gone, and stopping is the point.
        void closePlayback();
        forgetPlaybackUrls();
        setSession({ phase: 'signedOut', ended });
        return;
      }
      // A new sign-in: whatever ended the last one is not news any more.
      ended = null;
      /** Whether this sign-in has ever had a role: an account the door refuses never does. */
      let provisioned = false;

      const toProfile = (
        role: Role | undefined,
        data: Record<string, unknown> | null,
      ): Profile | null => {
        if (!data) return null;
        return isStaffRole(role)
          ? { kind: 'staff', doc: data as unknown as StaffUserDoc }
          : { kind: 'student', doc: data as unknown as StudentDoc };
      };

      const publish = (profile: Profile | null, claims: TokenClaims) => {
        // The observer has moved on — signed out, or a different account.
        if (cancelled || !chain.owns(gen)) return;
        if (claims.role) provisioned = true;
        const ready = isReady(claims, profile);
        // A gated account — pending, disabled, or not yet provisioned — is
        // denied by every rule, so denials while it is in that state say
        // nothing. Being disabled mid-session is the case that matters: the
        // claim flips under a screen that is still subscribed.
        setLiveDataSession(ready);
        // The role, so a refused read says which arm of the rules refused it.
        // The role only — no uid, no email: the privacy policy's promise.
        setSentryRole(claims.role ?? null);
        setSession({ phase: 'signedIn', user, profile, claims });

        /*
         * EVERYTHING THE GATE DECIDES, IN ONE BRANCH.
         *
         * The poll was written as a bare `else` on the push-registration test
         * below and bound to the wrong `if`: a READY account whose push token
         * was already claimed fell into it, so the second `publish` of every
         * healthy session — and there is always a second, since `start` arms
         * the listener and calls `poll`, and both publish — armed a permanent
         * three-second timer. Each tick force-refreshed the token and re-read
         * the profile, then published again and re-armed, for every signed-in
         * user for the life of the session.
         *
         * The audio stops here too. Being disabled mid-lecture never reaches
         * the signed-out branch — the claim flips while the credential is still
         * valid, and `App` swaps the whole navigator for the disabled screen,
         * taking the player and the docked bar with it and leaving a foreground
         * service running with nothing on screen to stop it.
         */
        if (!ready) {
          void closePlayback();
          forgetPlaybackUrls();
          /*
           * Every tick is a forced token refresh and a document read, and the
           * gate screen stays open for as long as an approval takes — hours,
           * on a tab somebody forgot. Quick while an admin is likely acting on
           * a fresh request, then a slow heartbeat; the profile listener
           * carries the approval itself the moment it lands, so the poll is
           * only ever a backstop for the claims.
           */
          chain.arm(gen, poll);
          return;
        }
        chain.stop();

        // Claim this device's push token once the account is usable. SILENT —
        // it never prompts, and only writes a token for a device already
        // permitted. Without it the sole thing that ever registers is a visit
        // to the notifications screen, so someone who granted permission and
        // never went back received nothing, and a rotated FCM token was never
        // replaced. The sibling apps have always done this at sign-in.
        if (pushRegisteredFor !== user.uid) {
          pushRegisteredFor = user.uid;
          void registerThisDevice(user.uid, false).catch(() => undefined);
        }
      };

      // Arm the live listener against whichever collection the claim points at.
      // Idempotent: a brand-new account has no claims yet, so the poll is what
      // eventually discovers where it belongs and arms this.
      const armListener = (role: Role) => {
        if (unsubDoc) return;
        unsubDoc = onSnapshot(
          doc(db, profileCollection(role), user.uid),
          (snap) => {
            // CAUGHT, like `poll`'s. `getIdTokenResult` rejects once the
            // credential is revoked — a disabled account, a sign-out elsewhere
            // — and a snapshot can still land in that window. Unhandled, it
            // surfaced as an uncaught FirebaseError on a screen that was already
            // on its way out; the auth observer is what deals with it.
            void (async () => {
              const fresh = (await user.getIdTokenResult()).claims as TokenClaims;
              const profile = toProfile(fresh.role, snap.exists() ? snap.data() : null);
              publish(profile, fresh);
              // Document says active but the token still lags: refresh now rather
              // than waiting for the next poll tick.
              if (profile && isStale(fresh, profile)) void poll();
            })().catch(profileListenerError);
          },
          profileListenerError,
        );
      };

      const poll = async () => {
        try {
          await user.getIdToken(true);
          const claims = (await user.getIdTokenResult()).claims as TokenClaims;
          const snap = await getDoc(doc(db, profileCollection(claims.role), user.uid));
          publish(toProfile(claims.role, snap.exists() ? snap.data() : null), claims);
          // Provisioning has landed — start watching live so later changes do not
          // wait for a poll tick.
          if (claims.role) armListener(claims.role);
        } catch (e) {
          const code = (e as { code?: string }).code;
          // The SDK has signed this account out before rethrowing, so the
          // signed-out branch above may already have run: say it either way.
          // And DISABLED while signed in: the profile shows the change, the
          // forced refresh is refused, and the SDK signs them out. That ended
          // on an empty sign-in form, said nothing, until the next attempt.
          const why: SessionEnd | null =
            code === 'auth/user-token-expired' && !provisioned ? 'refused' : code === 'auth/user-disabled' ? 'disabled' : null;
          if (why && auth.currentUser === null) {
            ended = why;
            setSession((s) => (s.phase === 'signedOut' ? { phase: 'signedOut', ended: why } : s));
          }
          console.warn('session poll', code ?? (e as Error).message);
          /*
           * AND TRY AGAIN. Only `publish` arms the chain, so a poll that failed
           * before publishing anything stayed failed: the first one, which
           * `start` calls directly, with the connection dropping as someone
           * signed in, left an account with no role yet on the sign-in screen,
           * signed in, until a reload. `arm` does nothing once this sign-in has
           * been superseded, and nothing while a tick is already waiting.
           */
          chain.arm(gen, poll);
        }
      };

      const start = async () => {
        const claims = (await user.getIdTokenResult()).claims as TokenClaims;
        if (claims.role) armListener(claims.role);
        // publish arms the poll whenever the account is not yet usable, which
        // covers both "the auth trigger has not run yet" and "still pending".
        await poll();
      };

      void start().catch((e) => {
        console.error('session bootstrap failed', e);
        void poll();
      });
    });

    return () => {
      cancelled = true;
      unsubAuth();
      unsubDoc?.();
      chain.stop();
    };
  }, []);

  return session;
}
