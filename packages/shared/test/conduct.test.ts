import { describe, it, expect } from 'vitest';
import { APPS_MAIL_SENDER, APPS_REPORTS_ADDRESS, RULES_VERSION, hasAcceptedRules } from '../src/conduct';

/**
 * Who meets the rules screen: an account that has never agreed, or agreed to
 * an earlier version of the rules. Nobody else, ever again.
 */
describe('hasAcceptedRules', () => {
  it('is false for an account that never agreed: every account made before the rules', () => {
    expect(hasAcceptedRules({})).toBe(false);
  });

  it('is false for an agreement to rules since changed', () => {
    expect(hasAcceptedRules({ rulesAcceptedAt: 1, rulesVersion: RULES_VERSION - 1 })).toBe(false);
  });

  it('is true once the account agreed to the rules as they stand', () => {
    expect(hasAcceptedRules({ rulesAcceptedAt: 1, rulesVersion: RULES_VERSION })).toBe(true);
  });
});

describe('the apps’ mail addresses', () => {
  it('are the institute’s: the sender and the administrators’ group', () => {
    expect(APPS_MAIL_SENDER).toEqual({ name: 'Sabeel Apps No Reply', address: 'apps-noreply@oursabeel.com' });
    expect(APPS_REPORTS_ADDRESS).toBe('apps-reports@oursabeel.com');
  });
});
