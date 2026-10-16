import { Platform } from 'react-native';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { BUILD_LABEL } from './buildInfo';

/**
 * The institute's rules and Report a problem, from the app's side. Both are
 * written by the server alone (`functions/src/conduct.ts`): the rules deny a
 * client any write to its own profile, and every client the `reports`
 * collection.
 */

/** Record that this account accepts the rules; its profile listener then lifts the gate. */
export const acceptRules = () => httpsCallable(functions, 'acceptRules')({}).then(() => undefined);

/** Whether the email to the administrators went: `failed` means the report is kept but not emailed. */
export type ReportMail = 'sent' | 'failed' | 'skipped';

/** Send a report, with where it came from so the administrators can place it. */
export const reportProblem = (text: string) =>
  httpsCallable<{ text: string; platform: 'android' | 'ios' | 'web'; appVersion: string }, { mail: ReportMail }>(
    functions,
    'reportProblem',
  )({
    text,
    platform: Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web',
    appVersion: BUILD_LABEL,
  }).then((r) => r.data.mail);
