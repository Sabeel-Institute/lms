import createIconSet from '@expo/vector-icons/createIconSet';
import font from './icons.ttf';
import glyphMap from './glyphmap.json';

/**
 * Every icon in the app, from a font holding only the glyphs it draws.
 *
 * The names are `names.json`'s, and nothing else type-checks: an icon missing
 * from the list fails `npm run typecheck` rather than drawing a blank. Add one
 * there, then run `npx sabeel-ci icons` (ci-tools' README, "Icons"). The glyphs
 * are Material Icons', so https://icons.expo.fyi (MaterialIcons) shows what
 * each name looks like.
 */
export type IconName = keyof typeof glyphMap;

export const Icon = createIconSet(glyphMap, 'sabeel-icons', font);
