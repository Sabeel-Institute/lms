/**
 * A page address with every document and account id in it replaced: the
 * route stays readable, and nobody is named.
 *
 * Staff pages carry a student's account id in their address (a student's
 * page, their ledger, the grading desk), and a crash report sent the address
 * as it was, which the privacy policy says no report carries. Firestore's ids
 * are 20 characters and an account's 28, letters and digits; a segment of
 * that kind becomes `:id`.
 */
export function withoutIds(address: string): string {
  return address.replace(/\/[A-Za-z0-9]{20,28}(?=[/?#]|$)/g, '/:id');
}
