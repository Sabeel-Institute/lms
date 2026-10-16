import { APP_NAME, APPS_REPORTS_ADDRESS, INSTITUTE_TIMEZONE, type Role } from '@sabeel/shared';
import type { OutgoingMail } from './mail';

/** What a report says about who sent it and from where. */
export interface ReportFacts {
  id: string;
  uid: string;
  displayName: string;
  email: string | null;
  role: Role;
  text: string;
  createdAt: number;
  platform?: ReportPlatform;
  appVersion?: string;
}

export type ReportPlatform = 'android' | 'ios' | 'web';

const PLATFORM_NAME: Record<ReportPlatform, string> = { android: 'on Android', ios: 'on iPhone', web: 'on the website' };

const ROLE_NAME: Record<Role, string> = { student: 'student', manager: 'staff (manager)', admin: 'staff (admin)' };

/** The moment, as the institute's administrators read the clock. */
export function instituteTime(at: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: INSTITUTE_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

/**
 * The email one report becomes: to the administrators' group, replying to the
 * person who sent it, their words verbatim under who, when and from where.
 */
export function reportMail(r: ReportFacts): OutgoingMail {
  const app = [APP_NAME, r.appVersion, r.platform ? PLATFORM_NAME[r.platform] : undefined]
    .filter(Boolean)
    .join(' ');
  const text = [
    `${r.displayName} sent this with Report a problem.`,
    '',
    `Name:    ${r.displayName}`,
    `Email:   ${r.email ?? '(none on the account)'}`,
    `Role:    ${ROLE_NAME[r.role]}`,
    `Account: ${r.uid}`,
    `When:    ${instituteTime(r.createdAt)}`,
    `App:     ${app}`,
    `Report:  ${r.id}`,
    '',
    'What they wrote:',
    '',
    r.text,
    '',
    '--',
    r.email
      ? `Reply to this email to answer ${r.displayName}; it goes to ${r.email}.`
      : 'The account has no email address, so a reply here reaches nobody.',
  ].join('\n');
  return {
    to: { address: APPS_REPORTS_ADDRESS },
    ...(r.email ? { replyTo: { name: r.displayName, address: r.email } } : {}),
    subject: `[${APP_NAME}] Report from ${r.displayName}`,
    text,
  };
}
