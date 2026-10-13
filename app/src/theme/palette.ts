/**
 * Raw color values. THE ONLY FILE IN THE APP ALLOWED TO CONTAIN COLOR LITERALS —
 * an ESLint rule enforces this everywhere under app/ except app/src/theme.
 *
 * These are the Sabeel Institute brand colors, **Option 1** — the designer's
 * revised palette (2026-07-21), which SUPERSEDES the original
 * `docs/brand/sabeel-color-usage-guide.jpg`. `docs/BRAND.md` restates it and
 * records where this palette deliberately departs from it for accessibility
 * (body text and gold-as-signal need deeper cuts). Read BRAND.md first.
 *
 * SINGLE LIGHT THEME. There is no dark mode — decided 2026-07-21. The app is
 * light only; `palette` is one object, not light/dark variants.
 *
 *   Warm Ivory     #F6EBDD   foundation — backgrounds, cards
 *   Soft Sage      #A8B89A   calm & community — alternate surfaces
 *   Dark Raspberry #83114F   brand identity — headings, buttons, links
 *   Antique Gold   #C6A15B   elegance — dividers, accents, hover
 *   Mushroom Taupe #A58D7A   support — borders, captions, shadows
 *
 * Option 1 is a real revision, not a re-measure: raspberry moved from a brick
 * red (#82163A) to this plum (ΔE ~17), and gold to a muted tan (ΔE ~13). Both
 * Both sibling apps (time-tracker, kanban) ship this same palette; this file is
 * a copy of the time-tracker's, which is the richer of the two.
 *
 * Nothing outside src/theme imports this. Screens consume the semantic tokens in
 * ./index.ts, so a brand refresh is a one-file change.
 */
export const palette = {
  // Warm Ivory carries the base; cards sit a shade brighter so they lift off it.
  canvas: '#F6EBDD',
  surface: '#FBF6F0',
  raised: '#FFFFFF',
  inset: '#E7DDD0',
  // Soft Sage tint — a deliberately sage-charactered fill for secondary buttons
  // and neutral status chips, so they sit apart from the near-ivory cards.
  bgSage: '#C3CAB1',
  // NOT Mushroom Taupe: that is ~2.7:1 on ivory and fails WCAG AA for body
  // text. These stay in the same warm family while remaining legible.
  textPrimary: '#3A2F28',
  textSecondary: '#6A5748',
  textMuted: '#A58D7A', // Mushroom Taupe — captions only, never body text
  textInverse: '#F9F2E9',

  // Borders lean on taupe and sage, where softness is the point.
  borderSubtle: '#DFD1C1',
  borderStrong: '#C9B7A7',

  // Dark Raspberry: key actions, headings, brand presence — used with purpose.
  accent: '#83114F',
  accentHover: '#660D3E',
  accentText: '#F9F2E9',
  accentSoft: '#E6CCC9',
  // Pale ivory-pink for muted text ON a raspberry fill: softer than full
  // textInverse but still legible on the plum.
  onAccentMuted: '#D0A3B3',

  danger: '#A32218',
  dangerSoft: '#F8E4E1',
  success: '#4E7A43', // Soft Sage, darkened enough to read on ivory
  // Antique Gold deepened to #977535 so a warning actually reads — true gold
  // #C6A15B is ~2.1:1 on ivory. Gold stays true where it is decoration, not
  // signal (borders, dividers); the semantic tokens keep those separate.
  warning: '#977535',

  // Decorative gold & sage — status chips (draft / published / overdue) will
  // lean on these, so both are carried from the start.
  // Gold true (#C6A15B) for decoration only; goldText (#795E2A, ~5.2:1) whenever
  // gold must be READ; sage as a secondary accent.
  gold: '#C6A15B',
  goldText: '#795E2A',
  sage: '#A8B89A',
  // Soft ivory-gold tint behind a pending/awaiting row.
  goldSoft: '#ECDCC3',
  // (text on a gold badge fill is textPrimary #3A2F28 — no separate token)

  overlay: '#3A2F2866',
  // The brand's darkest tone at 70%: a control drawn over a video's picture,
  // which may be any colour at all.
  videoControl: '#3A2F28B3',
  shadow: '#A58D7A33',
} as const;
