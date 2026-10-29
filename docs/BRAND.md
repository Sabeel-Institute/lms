# Brand

**Authority: the shared `sabeel-brand` skill** in
[Sabeel-Institute/brand](https://github.com/Sabeel-Institute/brand). This file
restates what this app needs and records where its token set goes beyond the
common one. When the two disagree, the skill wins — and the disagreement is a
bug to fix here.

The palette is the designer's **Option 1** (2026-07-21), shared exactly with the
sibling time-tracker and kanban apps. The test that catches drift: **put two
Sabeel apps side by side.** They must read as one identity. Checking a screen
against its own previous version only confirms the hexes changed; it never
exposes a proportion or chrome drift.

## The five brand colours

| Colour | Hex | Share | Role |
|---|---|---|---|
| Warm Ivory | `#F6EBDD` | ~35% | Foundation — backgrounds, cards |
| Soft Sage | `#A8B89A` | ~30% | Calm & community — alternate surfaces, success |
| Dark Raspberry | `#83114F` | ~20% | Brand identity — headings, buttons, links. A **plum**, not a red |
| Antique Gold | `#C6A15B` | ~10% | Elegance — dividers, accents, hover |
| Mushroom Taupe | `#A58D7A` | ~5% | Support — captions, borders, shadows |

**The proportions matter as much as the hexes.** Raspberry is spent with purpose
— a button, a heading, a link — never as a background wash.

## Chrome is ivory

Backgrounds, content areas **and chrome** are ivory. A nav header is a dark title
on the ivory canvas, not a raspberry bar; a raspberry app bar repeated on every
screen puts the brand colour far past its ~20% share, and "it's just the header"
does not exempt it. Sign-in is an ivory screen with a raspberry *button*, not a
full-bleed raspberry field.

The Phase 0 token screen follows this: the only raspberry field on it is the one
specimen card that exists to verify the on-accent tokens.

## Three accessibility cuts

The brand palette fails WCAG in the two uses people reach for first. Legibility
wins.

1. **Never set body text in Mushroom Taupe** — `#A58D7A` is ~2.7:1 on ivory. Use
   `text.primary` `#3A2F28` (~11:1) or `text.secondary` `#6A5748` (~5.8:1). True
   taupe is for captions, borders and dividers only.

   **The muted-vs-secondary test:** use `muted` only for text you could delete
   without losing information — a placeholder, a field hint, a decorative label.
   Anything that *conveys content* — a value, a status word, an empty state, a
   note — is `secondary`. When unsure, choose `secondary`.

2. **Gold cannot be read at brand strength** — `#C6A15B` is ~2.1:1 on ivory.
   `accent.goldText` `#795E2A` (~5.2:1) when it must be read as text;
   `feedback.warning` `#977535` (~3.6:1) as a status signal; true gold only as
   decoration.

3. **Raspberry is comfortable** — ~8.3:1 on ivory, and ivory `#F9F2E9` on a
   raspberry fill is ~8.8:1. Text on raspberry is warm ivory, never pure white.

**These cuts are measured ON IVORY and do not transfer.** On a raspberry fill the
gold cut *inverts*: true gold `#C6A15B` reads (~3.7:1) and the deepened `#795E2A`
reads worse, because the background is dark. Re-check any pair against its actual
background.

## Single light theme

There is **no dark mode** (decided 2026-07-21). No `prefers-color-scheme` branch,
no derived dark palette. `userInterfaceStyle` is pinned to `"light"` in
`app/app.json`.

## In this codebase

`app/src/theme/palette.ts` holds the raw values and is the **only** file allowed
to contain a colour literal — ESLint rejects a hex, rgb or hsl literal anywhere
else under `app/**`. `app/src/theme/index.ts` exposes semantic tokens named by
**role, not appearance** (`text.muted`, never `text.grey`).

- `useTheme()` inside components.
- `getTheme()` for module-scope `StyleSheet.create`, which cannot call a hook.
  Safe only because the theme is static; if a second theme were ever added, those
  static styles are what would need revisiting.

This app carries the fuller token set copied from the time-tracker — decorative
`accent.gold` / `accent.sage`, `accent.goldText`, `bg.goldSoft`, `bg.sage`,
`accent.onAccentMuted` — because recording status chips (draft, published,
needs attention, overdue) will use them.

**Per-app extension, do not push back into the skill:** any status scale this app
grows for recording lifecycle or ledger state is a functional scale like feedback
colours — tuned to stay mutually distinct and legible on ivory — and belongs
here, not in the shared skill.

## Fixed swatch sets

If users ever pick a colour, offer a **fixed set**, never a free picker. And do
not render a chip's own label in the swatch colour: it reads fine for raspberry
and fails instantly on gold (~2.1:1). Put the colour in a filled dot or bar and
keep the text at `text.primary`/`secondary`.

## Right values are not a right screen

Every mistake above survives a review that only checks the hex is correct — the
bugs are about *which token is used where*. Look at the rendered screen, on a
phone, with real content, before calling a colour decision done.

Phase 0's token screen exists for exactly this: it is screenshotted on the AVD
and on a web export, and read.

## The app icon

The brand's own icon (the `sabeel-brand` skill): the logo's raspberry
calligraphy alone, centred on Warm Ivory, no badge. The LMS is the Sabeel app
the public installs from the stores; the staff apps (Kanban, the Time Tracker)
carry the earlier mark with a badge each. The square icon has the calligraphy
across 76% of the tile; Android's adaptive foreground has it across 76% of
the 72dp a launcher shows, inside the safe circle.

`app/assets/icon.png`, `adaptive-icon.png` and `favicon.png`, and the Android
mipmaps Gradle compiles (`android/` is committed, so `app.json` alone changes
nothing a build sees), all come from the brand repository's generator,
`skills/sabeel-brand/tools/make-app-icons.py` in
[Sabeel-Institute/brand](https://github.com/Sabeel-Institute/brand) (the
`sabeel-brand` skill, "The apps' icons"), which cuts the calligraphy from the
brand logo on every run:

```sh
cd ../brand
uv run skills/sabeel-brand/tools/make-app-icons.py lms --repo ../lms
uv run skills/sabeel-brand/tools/make-app-icons.py lms --repo ../lms --check   # compare, write nothing
```

It re-proves the geometry on every run, and `--check` lists any icon file
here that is not what it makes; the images are not edited by hand.
iOS takes `icon.png` through `app.json` when `ios/` is generated. The Android
notification icon (`drawable/ic_notification.xml`) is a separate silhouette,
a microphone, because Android draws it from its alpha channel alone.
