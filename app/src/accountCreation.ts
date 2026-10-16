import { Platform } from 'react-native';

/**
 * WHETHER THIS BUILD MAY CREATE AN ACCOUNT. Web yes, the apps no.
 *
 * Apple 5.1.1(v) makes in-app account DELETION mandatory for any app that
 * supports account CREATION, and Google Play triggers on creating an account in
 * the app *or* directing the user to a creation flow outside it. Satisfy neither
 * trigger and neither requirement is engaged — which is the point: the deletion
 * flow the rule would demand has to decide what happens to a student's academic
 * record when they delete themselves, and academic records are retained. That is
 * the genuinely hard part, not the button.
 *
 * SO THE APPS MUST NOT POINT AT THE WEBSITE EITHER. There is no "create your
 * account on the web" line, no link, no explanation naming where it can be done
 * — a pointer at an external creation flow is the Play trigger word for word.
 * The affordance is simply not there, and staff who need to add a student use
 * the web app, which they already have.
 *
 * ONLY CREATION MOVES. Role changes, disable and re-enable, enrolment, and every
 * other administrative action stay in the app: none of them creates an identity,
 * and an admin should still be able to cut off a departing colleague from a
 * phone. Do not strip what is allowed to stay.
 *
 * See `docs/STORE-RELEASE.md`, the decision record.
 */
export const CAN_CREATE_ACCOUNTS = Platform.OS === 'web';
