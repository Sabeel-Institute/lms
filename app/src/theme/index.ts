/**
 * Semantic theme tokens. Every color in the app comes from here.
 *
 * SINGLE LIGHT THEME — no dark mode (decided 2026-07-21; see docs/BRAND.md).
 * `useTheme()` returns the one theme; it is a hook so a stored preference or a
 * second theme could be layered in here later without any screen changing.
 *
 * Usage inside a component:
 *   const t = useTheme();
 *   <View style={{ backgroundColor: t.bg.surface }}>
 *
 * Module-scope StyleSheet.create (which cannot call a hook) uses getTheme():
 *   const t = getTheme();
 *   const styles = StyleSheet.create({ card: { backgroundColor: t.bg.surface } });
 * This is safe precisely because the theme is static (single light theme) — the
 * value is fixed at module load. If a second theme is ever added, those static
 * styles are where it would need revisiting; screens using useTheme() would not.
 *
 * Names describe ROLE, not appearance — `text.muted`, never `text.grey`.
 *
 * Copied from the sibling time-tracker, which carries the fuller token set
 * (accent.gold / goldText / sage decorative accents, bg.goldSoft, bg.sage,
 * accent.onAccentMuted). This app needs those for recording status chips.
 * See docs/BRAND.md.
 */
import { palette } from './palette';

function build() {
  const p = palette;
  return {
    bg: {
      /** App background, behind everything. */
      canvas: p.canvas,
      /** Cards, sheets, list rows. */
      surface: p.surface,
      /** Surfaces that sit above other surfaces (menus). */
      raised: p.raised,
      /** Recessed areas — text inputs. */
      inset: p.inset,
      /** Tint behind selected/active items. */
      accentSoft: p.accentSoft,
      /** Tint behind destructive confirmation. */
      dangerSoft: p.dangerSoft,
      /** Ivory-gold tint behind a pending / awaiting row. */
      goldSoft: p.goldSoft,
      /** Sage-charactered fill for secondary buttons and neutral chips. */
      sage: p.bgSage,
      /** Behind a video's picture, where it does not fill the frame: the
       *  brand's darkest tone rather than a black the palette does not have. */
      video: p.textPrimary,
    },
    text: {
      primary: p.textPrimary,
      secondary: p.textSecondary,
      /** Captions, placeholders — never body text. */
      muted: p.textMuted,
      /** Text on an accent (raspberry) fill. */
      inverse: p.textInverse,
      accent: p.accent,
      danger: p.danger,
    },
    border: {
      subtle: p.borderSubtle,
      strong: p.borderStrong,
    },
    accent: {
      base: p.accent,
      hover: p.accentHover,
      onAccent: p.accentText,
      /** Muted text on a raspberry fill (e.g. a secondary line on an accent card). */
      onAccentMuted: p.onAccentMuted,
      /** Decorative gold — dividers, hairline borders, fills. NOT read-critical. */
      gold: p.gold,
      /** Gold used AS TEXT (labels, status). Deepened to read on ivory. */
      goldText: p.goldText,
      /** Decorative sage — status dots, accent borders. */
      sage: p.sage,
    },
    feedback: {
      danger: p.danger,
      success: p.success,
      warning: p.warning,
    },
    effect: {
      /** Scrim behind a modal. */
      overlay: p.overlay,
      /** Behind a control drawn over a video's picture. */
      videoControl: p.videoControl,
      shadow: p.shadow,
    },
  } as const;
}

export type Theme = ReturnType<typeof build>;

const theme: Theme = build();

/**
 * The app theme. A hook by design: if a manual override or a second theme is
 * ever added, this is the single place it layers in and no screen needs touching.
 */
export function useTheme(): Theme {
  return theme;
}

/** Non-hook access, for module-scope styles and `.web` seams that cannot use hooks. */
export function getTheme(): Theme {
  return theme;
}

/** Spacing scale, in points — 4pt grid. */
export const spacing = (n: number) => n * 4;

/**
 * The font the DOM seams set on a raw element — the web `<select>` and
 * `<input type="date">`, which react-native-web does not style.
 *
 * `inherit` was wrong there: RNW puts its font on every `Text`, never on the
 * body, so a raw element inherits the browser's default — a serif, beside a
 * page set entirely in the system sans. This is the stack RNW resolves the
 * `System` family to (`createReactDOMStyle`), restated once so the two seams
 * cannot drift from it separately.
 */
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * The width the content column stops growing at.
 *
 * The READING maximum: prose, forms, a single record. Below it a screen is
 * full-bleed; at and above it the column caps here and centres, so the empty
 * space lands on both sides instead of leaving lines too long to read.
 *
 * One of two maximums — see `LAYOUT_WIDTHS` below — and a different number
 * again from `WIDE_BREAKPOINT`, which answers a different question. This one is
 * a typographic limit, and it is reached long before a window is wide enough to
 * give up space to a rail.
 *
 * `scripts/screens-e2e.mjs` READS THIS FILE for the number rather than keeping
 * its own copy, and picks its viewport widths to straddle it. A constant
 * restated in the test that checks it drifts from the thing it is testing.
 */
export const CONTENT_MAX_WIDTH = 720;

/**
 * The width at and above which the app switches to its DESKTOP layout.
 *
 * Branch on width, never on platform: a tablet in landscape deserves the wide
 * layout and a half-width browser window deserves the phone one. Above this the
 * navigation chrome becomes a left rail, list screens flow into a grid, and a
 * standalone button sizes to its label instead of spanning the window.
 *
 * 900 rather than 720: `CONTENT_MAX_WIDTH` is the point a READING column stops
 * growing, which is a typographic limit and is reached long before a window is
 * wide enough to give up 76px to a rail and still hold a useful content area.
 * The two numbers answer different questions and must not be merged.
 */
export const WIDE_BREAKPOINT = 900;

/**
 * The two content maximums, one per kind of content.
 *
 * A single "content width" cannot serve both, which is what makes a
 * phone-first app look stretched on a laptop: prose capped for readability
 * leaves a card list stranded in a narrow ribbon down the middle of a 1600px
 * window, and a card list allowed to fill the window drags body copy out to
 * unreadable line lengths.
 *
 *   read  text, forms, a single record — line length is the constraint
 *   list  card and row collections — these want the room, and flow into columns
 *
 * Two, because every screen that uses `Screen` is one or the other. The player
 * is the exception that matters and does not use `Screen` at all: a transport,
 * a scrub bar and a rate row are a media column, narrower than prose, and it
 * caps itself at 560. That is a deliberate third width with one member, kept
 * where it is used rather than offered here for screens that would misuse it.
 */
export const LAYOUT_WIDTHS = {
  read: CONTENT_MAX_WIDTH,
  list: 1180,
} as const;

export type LayoutWidth = keyof typeof LAYOUT_WIDTHS;

/** Rail width on wide screens; the bar's height is content-driven. */
export const RAIL_WIDTH = 76;
