import { ALLOWED_EMAIL_DOMAIN } from './auth';

/**
 * THE INSTITUTE'S RULES, AND REPORTING A PROBLEM.
 *
 * Both stores treat what people post here (assignments, hand-ins, files,
 * feedback) as user-generated content, and ask for terms accepted before
 * anyone posts and a way to report content and people. Decided by Faisal on
 * 2026-10-16 for every Sabeel app: the rules accepted once per account, and
 * "Report a problem" emailing the administrators. See `docs/STORE-RELEASE.md`,
 * decision 4.
 */

/**
 * The rules as they stand. An account that accepted an earlier version sees
 * the rules screen again; raise this only when the rules themselves change.
 */
export const RULES_VERSION = 1;

/** What a profile records about the rules. Written only by `acceptRules`. */
export interface RulesAcceptance {
  /** When the account accepted, epoch ms, server time. */
  rulesAcceptedAt?: number;
  /** Which version of the rules it accepted. */
  rulesVersion?: number;
}

/** Has this account accepted the rules as they stand? */
export function hasAcceptedRules(profile: RulesAcceptance): boolean {
  return (profile.rulesVersion ?? 0) >= RULES_VERSION;
}

/**
 * The sender every Sabeel app's server mails as: a Workspace user nobody signs
 * in to, reached through domain-wide delegation (`functions/src/gmail.ts`).
 */
export const APPS_MAIL_SENDER = { name: 'Sabeel Apps No Reply', address: `apps-noreply@${ALLOWED_EMAIL_DOMAIN}` } as const;

/** The Workspace group "Report a problem" mails; the administrators are in it. */
export const APPS_REPORTS_ADDRESS = `apps-reports@${ALLOWED_EMAIL_DOMAIN}`;
