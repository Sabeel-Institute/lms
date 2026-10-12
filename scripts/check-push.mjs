/**
 * Is the push SEND PATH reachable and authenticated against the real project?
 *
 *     npm run check:push
 *
 * WHY THIS EXISTS: there is no FCM emulator, so the tests stub the sender and
 * assert only who WOULD have been messaged. That leaves `functions/src/messaging.ts`
 * with no automated coverage at all, and the signature failure of push is that
 * every visible part works while nothing is delivered.
 *
 * It proves the two things provable without a device:
 *
 *   1. **The client half is configured.** `VAPID_PUBLIC_KEY` is present and is a
 *      real uncompressed P-256 point — which is what a browser refuses if it was
 *      truncated, or pasted from the wrong field.
 *   2. **The server half is reachable and authorized.** A send to a deliberately
 *      bogus token comes back `registration-token-not-registered`, meaning the
 *      request reached FCM and was accepted as OURS. Cloud Messaging disabled,
 *      the wrong project, or absent credentials all fail differently, earlier,
 *      and loudly.
 *
 * The same call pins the pruning logic to reality: the code FCM returns for a
 * dead token is one `functions/src/messaging.ts` would prune on — read out of
 * that file, so it is confirmed rather than guessed from documentation or
 * restated here.
 *
 * WHAT IT CANNOT DO is mint a browser token. Playwright's Chromium is the
 * open-source build, which ships without the Google API keys needed to reach
 * FCM's push service, and branded Chrome under Playwright refuses too
 * (`AbortError: Registration failed - permission denied`). Neither says anything
 * about this project's key. Web delivery is a human check in a real browser;
 * Android delivery was confirmed on a device on 2026-08-15 (see the
 * verification log in docs/PHASE_STATUS.md).
 *
 * Reads and writes nothing: no Firestore, no documents, no real recipient.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { FIREBASE_PROJECT_ID as projectId } from '@sabeel/shared';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const ROOT = new URL('..', import.meta.url);

// Read the SHIPPED key rather than restating it, so this cannot pass against a
// key the app does not actually carry. The project id is the shared constant
// the app's config is built from.
const config = readFileSync(new URL('app/src/firebase-config.ts', ROOT), 'utf8');
const vapid = config.match(/VAPID_PUBLIC_KEY\s*=\s*\n?\s*'([^']*)'/)?.[1] ?? '';

console.log(`Push send path against ${projectId}\n`);

let failed = false;

// A VAPID public key is an uncompressed P-256 point: 65 bytes, leading 0x04,
// base64url. Every way of getting it wrong — the private half, a truncated
// paste, the sender id — fails one of those, and only ever surfaces in a
// browser, on someone else's machine.
const raw = Buffer.from(vapid.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
if (vapid && raw.length === 65 && raw[0] === 0x04) {
  console.log(`  ok    VAPID_PUBLIC_KEY is a valid P-256 point (${vapid.length} chars)`);
} else {
  failed = true;
  console.log(
    vapid
      ? `  FAIL  VAPID_PUBLIC_KEY is not a P-256 point (${raw.length} bytes, leads 0x${raw[0]?.toString(16)})`
      : '  FAIL  VAPID_PUBLIC_KEY is empty — web push would register no tokens',
  );
}

admin.initializeApp({ projectId });
const res = await admin.messaging().sendEachForMulticast({
  tokens: ['dGhpcy1pcy1ub3QtYS10b2tlbg:APA91bHnotarealtokennotarealtokennotareal'],
  notification: { title: 'reachability probe', body: 'never delivered to anyone' },
});

/*
 * THE PRUNING CODES, READ FROM THE PRUNER — not restated here.
 *
 * The point of this probe is that the code FCM actually returns for a dead token
 * is one the app would prune on. Comparing against a literal typed into this
 * file proved only that the literal matched itself: drop
 * `messaging/registration-token-not-registered` from `DEAD_TOKEN_CODES` and
 * `isDeadToken` stops pruning the one code FCM really sends, while this script
 * still printed "the send path is ready". `firebase-config.ts` is already read
 * from source a few lines up for the same reason.
 */
const messagingSrc = readFileSync(new URL('functions/src/messaging.ts', ROOT), 'utf8');
const deadCodes = [
  ...(messagingSrc
    .match(/const DEAD_TOKEN_CODES = new Set\(\[([\s\S]*?)\]\)/)?.[1]
    .matchAll(/'([^']+)'/g) ?? []),
].map((m) => m[1]);
if (deadCodes.length === 0) {
  failed = true;
  console.log('  FAIL  DEAD_TOKEN_CODES is no longer readable from functions/src/messaging.ts');
}

const code = res.responses[0].error?.code;
if (deadCodes.includes(code)) {
  console.log(`  ok    FCM authenticated us, and rejected the bogus token as ${code}`);
  console.log('        — a code isDeadToken() prunes on, so stale registrations are cleaned up');
} else {
  failed = true;
  console.log(`  FAIL  unexpected answer from FCM: ${code ?? 'the bogus token was ACCEPTED'}`);
  console.log(`        isDeadToken() prunes on: ${deadCodes.join(', ') || '(nothing)'}`);
  console.log('\n        An auth or permission code here means Cloud Messaging is off,');
  console.log('        or these credentials are not this project.');
}

console.log(
  failed
    ? '\nthe send path is NOT ready'
    : '\nthe send path is ready; a banner appearing is still a device check',
);
process.exit(failed ? 1 : 0);
