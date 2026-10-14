import { HttpsError } from 'firebase-functions/v2/https';
import {
  HELP_VARIANTS,
  HELP_VIDEOS,
  SIGNED_URL_TTL_MS,
  helpVideoKey,
  helpVideosFor,
  type HelpVariant,
  type TokenClaims,
} from '@sabeel/shared';
import { reportedCall } from './reported';
import { MEDIA_READ_SECRETS, signGet } from './mediaStore';

/**
 * May this caller watch this help film, and if not, why? A student watches
 * the students' films and no others; staff watch every film, the students'
 * included (`helpVideosFor`). Every branch is driven through the callable,
 * with links that play, in help.integration.test.ts.
 */
function helpVideoDenial(claims: TokenClaims, id: string): string | null {
  if (!HELP_VIDEOS.some((v) => v.id === id)) return 'There is no such help film.';
  const role = claims.role;
  if (role !== 'student' && role !== 'manager' && role !== 'admin') return 'That film is not open to you.';
  return helpVideosFor(role).some((v) => v.id === id) ? null : 'That film is not open to you.';
}

/**
 * Signed links to one help film and its captions, for one of its two cuts.
 *
 * The films live in the same private bucket as the class recordings, under
 * `help/`, and reach a screen only as links that expire — the same rule the
 * recordings keep. Signed with the read key alone: a film not uploaded yet
 * answers its link with a 404, which the player says in words, so this needs
 * no key that can look into the bucket.
 */
export const getHelpVideoUrl = reportedCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const claims = (req.auth.token ?? {}) as TokenClaims;
  if (claims.status !== 'active') throw new HttpsError('permission-denied', 'Account is not active.');
  const id = req.data?.id;
  if (typeof id !== 'string' || !id) throw new HttpsError('invalid-argument', 'id is required.');
  const variant = req.data?.variant as HelpVariant;
  if (!HELP_VARIANTS.includes(variant)) throw new HttpsError('invalid-argument', 'variant must be phone or computer.');
  const denial = helpVideoDenial(claims, id);
  if (denial) throw new HttpsError('permission-denied', denial);
  const [video, captions] = await Promise.all([
    signGet(helpVideoKey(id, variant, 'video'), SIGNED_URL_TTL_MS),
    signGet(helpVideoKey(id, variant, 'captions'), SIGNED_URL_TTL_MS),
  ]);
  return { video, captions };
}, MEDIA_READ_SECRETS);
