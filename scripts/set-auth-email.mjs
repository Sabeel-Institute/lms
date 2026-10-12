#!/usr/bin/env node
/**
 * Apply the password email's wording to the project's Firebase Auth config.
 *
 *     node scripts/set-auth-email.mjs          # show what would change
 *     node scripts/set-auth-email.mjs --yes    # apply it
 *
 * Config as code, like the rules: the console's template editor is never the
 * source. Re-run after creating a project or changing the words here.
 *
 * ONE TEMPLATE, TWO JOURNEYS. Firebase sends the same "password reset" email
 * when staff add a student (who has never had a password) and when a student
 * asks for a link from the sign-in screen or More → Change password. So it
 * says "set", which is right for both, rather than "reset", which reads to a
 * new student as though something has gone wrong.
 *
 * It names the app and nothing else: no way to get an account, which the
 * Android app's store exemption depends on (CLAUDE.md).
 *
 * Authenticates as the active gcloud account, which must be able to edit the
 * project's Identity Platform config (faisal.shah@oursabeel.com is).
 */
import { execFileSync } from 'node:child_process';
import { APP_NAME, FIREBASE_PROJECT_ID } from '@sabeel/shared';

const HELP_ADDRESS = 'admin@oursabeel.com';
const ACCENT = '#8A1538'; // docs/BRAND.md primary

const template = {
  senderDisplayName: 'Sabeel Institute',
  replyTo: HELP_ADDRESS,
  subject: `Set your ${APP_NAME} password`,
  bodyFormat: 'HTML',
  body: [
    '<p>Assalamu alaikum,</p>',
    `<p>Use the link below to set the password for your ${APP_NAME} account, %EMAIL%. ` +
      'If your teacher has just added you, this is how you create your password. ' +
      'If you asked for a new one, it replaces your old password.</p>',
    `<p><a href="%LINK%" style="display:inline-block;padding:10px 18px;border-radius:6px;` +
      `background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600">Set my password</a></p>`,
    `<p>Then sign in with %EMAIL% and your new password.</p>`,
    '<p>The link works once and expires after an hour. If it has expired, choose ' +
      '<em>Email me a password link</em> on the sign-in screen for a new one. ' +
      'If you did not expect this email, you can ignore it; nothing changes until the link is used.</p>',
    `<p>Need help? Email <a href="mailto:${HELP_ADDRESS}">${HELP_ADDRESS}</a>.</p>`,
    '<p>JazakAllahu khayran,<br>Sabeel Institute</p>',
  ].join('\n'),
};

const apply = process.argv.includes('--yes');
const extra = process.argv.slice(2).filter((a) => a !== '--yes');
if (extra.length > 0) {
  console.error(`usage: set-auth-email.mjs [--yes]  (unexpected: ${extra.join(' ')})`);
  process.exit(2);
}

const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${FIREBASE_PROJECT_ID}/config`;
const headers = {
  Authorization: `Bearer ${token}`,
  'X-Goog-User-Project': FIREBASE_PROJECT_ID,
  'Content-Type': 'application/json',
};

async function current() {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`read config: ${res.status} ${await res.text()}`);
  return (await res.json()).notification?.sendEmail?.resetPasswordTemplate ?? {};
}

const before = await current();
const changed = Object.keys(template).filter((k) => before[k] !== template[k]);
console.log(`${FIREBASE_PROJECT_ID}: password email, ${changed.length} field(s) differ: ${changed.join(', ') || 'none'}`);
if (!apply || changed.length === 0) {
  if (changed.length > 0) console.log('Dry run. Pass --yes to apply.');
  process.exit(0);
}

/*
 * ONE FIELD AT A TIME. Google refuses some fields on some projects with
 * EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED: on oursabeel-lms (2026-10-12) the sender
 * name and reply-to apply and the subject and body are refused, which no
 * public documentation explains. A refusal is reported and fails the run;
 * the fields that can apply still do, so a re-run later completes the rest.
 */
const refused = [];
for (const field of changed) {
  const res = await fetch(`${url}?updateMask=notification.sendEmail.resetPasswordTemplate.${field}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ notification: { sendEmail: { resetPasswordTemplate: { [field]: template[field] } } } }),
  });
  if (!res.ok) refused.push(`${field} (${res.status} ${(await res.json()).error?.message})`);
}

const after = await current();
const stillDiffer = Object.keys(template).filter((k) => after[k] !== template[k]);
if (refused.length > 0 || stillDiffer.length > 0) {
  console.error(`Refused: ${refused.join(', ') || 'none'}. Still different: ${stillDiffer.join(', ') || 'none'}.`);
  process.exit(1);
}
console.log('Applied and read back.');
