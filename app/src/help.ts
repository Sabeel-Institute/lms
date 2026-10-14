import { httpsCallable } from 'firebase/functions';
import type { HelpVariant } from '@sabeel/shared';
import { functions } from './firebase';

interface Signed {
  url: string;
  expiresAt: number;
}

/** Links to one cut of a help film and its captions, signed for this person — see `getHelpVideoUrl`. */
export const helpFilmLinks = (id: string, variant: HelpVariant) =>
  httpsCallable<{ id: string; variant: HelpVariant }, { video: Signed; captions: Signed }>(functions, 'getHelpVideoUrl')({
    id,
    variant,
  }).then((r) => r.data);
