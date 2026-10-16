import { describe, it, expect } from 'vitest';
import { ALLOWED_EMAIL_DOMAIN } from '@sabeel/shared';
import { decideProvision, refusedSignIn, refusedSignUp } from '../../src/provision';

const staffEmail = `teacher@${ALLOWED_EMAIL_DOMAIN}`;
const google = (over: Partial<Parameters<typeof decideProvision>[0]> = {}) =>
  decideProvision({
    email: staffEmail,
    emailVerified: true,
    displayName: 'A Teacher',
    photoURL: null,
    providerIds: ['google.com'],
    ...over,
  });

describe('decideProvision — staff via Google', () => {
  it('provisions a verified org address as a pending manager', () => {
    const d = google();
    expect(d.action).toBe('provision');
    if (d.action !== 'provision') return;
    // Pending grants nothing; an admin must approve. Domain membership alone is
    // explicitly not authorisation.
    expect(d.claims).toEqual({ role: 'manager', status: 'pending' });
    expect(d.profile.email).toBe(staffEmail);
  });

  it('rejects an address outside the org domain', () => {
    expect(google({ email: 'someone@gmail.com' }).action).toBe('reject');
  });

  it('rejects an unverified org address', () => {
    expect(google({ emailVerified: false }).action).toBe('reject');
  });

  it('falls back to the local part when Google sends no display name', () => {
    const d = google({ displayName: null });
    expect(d.action === 'provision' && d.profile.displayName).toBe('teacher');
  });

  it('falls back when the display name is only whitespace', () => {
    const d = google({ displayName: '   ' });
    expect(d.action === 'provision' && d.profile.displayName).toBe('teacher');
  });
});

describe('decideProvision — students via email/password', () => {
  it('REJECTS a password account, because that can only be a client sign-up', () => {
    // The counterpart to the test below. A real student is created WITHOUT a
    // password, so it has no provider at creation; anything that already has
    // `password` when the trigger fires got it from the client SDK, which no
    // legitimate flow in this app uses.
    //
    // This branch returned 'ignore' until 2026-07-22, on the assumption that
    // console-level sign-up was disabled. It cannot be — that setting also
    // blocks a staff member's first Google sign-in — so the guard lives here.
    const d = decideProvision({
      email: 'stranger@example.com',
      emailVerified: false,
      providerIds: ['password'],
    });
    expect(d.action).toBe('reject');
    expect(d.action === 'reject' && d.reason).toBe('self-signup');
  });

  it('ignores an Admin-SDK account that has NO provider yet', () => {
    // The bug this exists to prevent: createStudent deliberately creates the
    // account WITHOUT a password so the student sets their own, and such a user
    // has empty providerData until they do. Rejecting it deleted every student
    // seconds after creation, and the failure looked intermittent because it
    // depended on trigger timing.
    const d = decideProvision({
      email: 'student@example.com',
      emailVerified: false,
      providerIds: [],
    });
    expect(d.action).toBe('ignore');
  });

  it('still rejects a providerless account with NO email', () => {
    // Anonymous sign-in also has empty providerData. The address is what
    // separates a real staff-created student from one.
    const d = decideProvision({ email: null, providerIds: [] });
    expect(d.action).toBe('reject');
  });

  it('rejects a self-signup regardless of domain', () => {
    // Including the staff domain: staff sign in with Google, so a password
    // account on the org domain is someone guessing at the front door, not a
    // colleague.
    for (const email of ['a@gmail.com', `b@${ALLOWED_EMAIL_DOMAIN}`, null]) {
      expect(decideProvision({ email, providerIds: ['password'] }).action).toBe('reject');
    }
  });

  it('ignores a providerless student regardless of domain', () => {
    // The rule that survives from before: students are not org members and never
    // will be, so the staff domain gate must not be applied to them.
    for (const email of ['a@gmail.com', `b@${ALLOWED_EMAIL_DOMAIN}`]) {
      expect(decideProvision({ email, providerIds: [] }).action).toBe('ignore');
    }
  });
});

describe('decideProvision — everything else', () => {
  it('rejects providers we do not use', () => {
    for (const provider of ['facebook.com', 'apple.com', 'anonymous', 'phone']) {
      const d = decideProvision({ email: staffEmail, emailVerified: true, providerIds: [provider] });
      expect(d.action).toBe('reject');
      expect(d.action === 'reject' && d.reason).toBe('unsupported-provider');
    }
  });

  it('rejects an account that arrives already carrying both providers', () => {
    // No flow here produces this at CREATION time: a student is created with no
    // provider, and a staff member's first Google sign-in has only google.com.
    // Linking happens later and does not re-fire onCreate. So both-at-once is
    // anomalous, and the safe reading of anomalous is reject — the account has
    // no claims and nothing to lose.
    expect(
      decideProvision({
        email: 'student@example.com',
        providerIds: ['password', 'google.com'],
      }).action,
    ).toBe('reject');
  });
});

/*
 * THE DOOR BEFORE THE ACCOUNT (the blocking sign-up gate). Every sign-up it
 * sees came from a client; the one legitimate kind is a colleague's first
 * Google sign-in on the staff domain.
 */
describe('refusedSignUp', () => {
  it('lets a colleague in with a verified staff Google account', () => {
    expect(refusedSignUp('google.com', staffEmail, true)).toBeNull();
  });

  it('refuses a password sign-up, whatever the address', () => {
    expect(refusedSignUp('password', 'someone@example.com', false)).toBe('self-signup');
    expect(refusedSignUp('password', staffEmail, true)).toBe('self-signup');
  });

  it('refuses Google accounts off the staff domain, and unverified ones on it', () => {
    expect(refusedSignUp('google.com', 'someone@gmail.com', true)).toBe('bad-domain');
    expect(refusedSignUp('google.com', staffEmail, false)).toBe('bad-domain');
  });

  it('refuses every other way in, and a sign-up that names none', () => {
    for (const provider of ['facebook.com', 'apple.com', 'anonymous', 'phone', null]) {
      expect(refusedSignUp(provider, staffEmail, true)).toBe('unsupported-provider');
    }
  });
});

describe('refusedSignIn', () => {
  it('lets a student in with a password, and anyone in with Google', () => {
    expect(refusedSignIn('password', { role: 'student', status: 'active' })).toBeNull();
    for (const role of ['admin', 'manager', 'student'] as const) expect(refusedSignIn('google.com', { role, status: 'active' })).toBeNull();
  });

  it('refuses a password to staff and to an account with no role', () => {
    expect(refusedSignIn('password', { role: 'manager', status: 'active' })).toBe('not-a-student');
    expect(refusedSignIn('password', { role: 'admin', status: 'active' })).toBe('not-a-student');
    expect(refusedSignIn('password', {})).toBe('not-a-student');
    expect(refusedSignIn('password', undefined)).toBe('not-a-student');
  });
});
