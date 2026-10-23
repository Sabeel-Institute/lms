#!/usr/bin/env node
/**
 * THE visual/layout regression sweep. Every screen, every width, looked at AND
 * checked.
 *
 *   bash scripts/e2e-stack.sh screens                   # the CI set
 *   SWEEP_WIDTHS=320 bash scripts/e2e-stack.sh screens  # one width, tight loop
 *   SWEEP_FULL=1 bash scripts/e2e-stack.sh screens      # + real device profiles
 *
 * A TOUR THAT CANNOT FAIL IS A SCREENSHOT GENERATOR. This one exits non-zero,
 * and `functions/test/unit/ciCoverage.test.ts` fails if CI ever stops running
 * it. That is the whole difference between this and a folder of pretty pictures
 * nobody diffs.
 *
 * WHAT IT CHECKS, and the failure each check is here for:
 *
 *   - the page never scrolls sideways    the classic responsive failure a
 *                                        top-of-page screenshot never reveals
 *   - nothing is clipped by the right    distinct from the above: a row can
 *     edge                               overflow INSIDE a clipping ancestor, so
 *                                        the page width never moves while a
 *                                        control is sliced in half at the
 *                                        boundary. This app's `rowHeadPinned`
 *                                        rows — a name that may not shrink
 *                                        beside actions that may not shrink —
 *                                        are exactly that shape
 *   - no two same-layer controls         crowding that appears at one width and
 *     overlap                            not another
 *   - no navigation label is cut     a tab name clipped to "Recordi…" inside
 *     short                              its own cell passes every check above
 *   - every screen has a way out         a pushed screen with no Back is a dead
 *                                        end in a phone browser, where there is
 *                                        no hardware Back either. A tab root is
 *                                        never pushed and correctly has none —
 *                                        the bar or the rail is its exit — so
 *                                        the check asks for whichever applies
 *   - the content column caps at one of  read from `app/src/theme/index.ts`
 *     the declared maxima, and centres   rather than restated here. A reading
 *                                        column and a card grid want opposite
 *                                        things from a wide window, so there is
 *                                        more than one legal answer
 *   - no interactive content nested      `accessibilityRole="button"` becomes a
 *     inside a <button>                  real <button> ELEMENT on web, and keys
 *                                        pressed in a control inside one
 *                                        activate the button
 *   - no fixed-format control is        the only ABSOLUTE-width check here. A
 *     squashed below its own widget      date/time/number input or a select can
 *                                        sit inside its container, overlap
 *                                        nothing, clip nothing, and still be too
 *                                        narrow to read — and unlike a text
 *                                        field, its content cannot be scrolled to
 *   - the page laid out at the width    everything else measures the DOM against
 *     it was asked for                   the DOM, which is silent about WHICH
 *                                        width it ran at. Without this, a
 *                                        viewport option that failed to apply
 *                                        leaves every check passing and every
 *                                        screenshot mislabelled
 *   - targets under 44px are REPORTED    informational, never a failure
 *
 * Deliberately NOT checked: a generic "is any text truncated". It fires on every
 * intentional `numberOfLines` clamp and would drown the real signal. Scope such
 * a check to the one surface that needs it, if any ever does.
 *
 * TWO POPULATIONS, THREE TOURS. Staff and students are different apps behind one
 * binary — different route tables, different homes, no screen in common but the
 * player and notifications — so a sweep that signed in as an admin would have
 * photographed half the product. A manager gets a third tour because their
 * scoping is class-by-class: they see the same screens with fewer rows and fewer
 * controls, which is a different layout, not the same one with less in it.
 *
 * A SCREEN WITH AN EDITOR OPEN IS A DIFFERENT SCREEN. The session editor adds
 * four fields and a Save/Cancel row; the ledger's override adds a reason field
 * and two buttons; a roster removal replaces a row in place with a confirmation.
 * None of those rows exist in any other state, and 320px is where they run out
 * of room — so they are toured explicitly rather than trusted because the screen
 * underneath them measured fine.
 *
 * That paid for itself on the first honest run: the ledger's override laid its
 * two actions out in a bespoke non-wrapping row, and "Mark not complete" ran
 * 27px off the right edge at 320px and at no other width. Fixed by using the
 * shared `Row`, which wraps.
 *
 * The AUDIO PLAYER's behaviour is not this suite's business — background
 * playback, the foreground service and lock-screen controls have no web
 * equivalent and belong on the AVD. Its LAYOUT is, and it is the one screen
 * whose controls sit in a fixed-width row, so it is toured at every width.
 *
 * Seeding goes through the Admin SDK: deterministic, seconds rather than
 * minutes, and rules will not let a client write most of it anyway. The content
 * is chosen to BREAK layouts — the longest name a real cohort would have, a
 * roster longer than one screen, an empty cohort — not to look tidy.
 */
import { fileURLToPath } from 'node:url';
import { config } from '@sabeel-institute/ci-tools/lib/config.mjs';
import { emulatorProject, ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';
import { chromium, devices } from 'playwright';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
import { backButton, byId, byName, resetEmulators, seedWorld, tap } from './lib/seed-world.mjs';
// The built workspace package — `e2e-stack.sh` builds it before this runs.
import { PUSH_DEVICE_MESSAGE, addDays } from '@sabeel/shared';

// The emulator ports and project, from ci-tools.json (`npx sabeel-ci ports`).
const STACK = config(fileURLToPath(new URL('..', import.meta.url)));
const PORTS = ports(STACK);
const EMULATOR_PROJECT_ID = emulatorProject(STACK);

const BASE = process.env.E2E_BASE ?? `http://127.0.0.1:${PORTS.sweep}/`;
const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'shots', 'screens');
const PROJECT = EMULATOR_PROJECT_ID;
const FULL = process.env.SWEEP_FULL === '1';

process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${PORTS.auth}`;
process.env.GCLOUD_PROJECT = PROJECT;

const results = [];
/**
 * How many fixed-format controls the squash check has actually looked at.
 *
 * GUARD THE GUARD. That check's loop body is the only thing in it that can
 * produce a fault, so if its selector ever matches nothing — react-native-web
 * changing how it renders a date input, the app dropping `DateField` — it
 * reports zero faults and the sweep stays green, silently, for good. The same
 * hole `ciCoverage.test.ts` guards against with its glob, and the same shape as
 * this check's own first version, which could not fail because its signal was
 * blind rather than because its population was empty. Both pass. Both look
 * exactly like working.
 */
let fixedFormatSeen = 0;
/**
 * Totals, printed rather than asserted on.
 *
 * The control population is guarded PER SCREEN, inside `layoutFaults`, because
 * every screen has controls and a starved one should name itself. Fixed-format
 * controls are guarded per RUN instead: a screen with no date field is
 * ordinary, a whole sweep with none is not. That asymmetry is the point — a
 * per-run guard is one line that says only "somewhere", so use it only where a
 * per-screen expectation does not exist.
 *
 * Note `escapes()` asks its question as `controls.some(...)`, and a `some()`
 * over an empty set is FALSE — it fails loudly on the very starvation the `for`
 * loops hide, needing no guard at all. Measured next door: the same sabotage
 * caught by `some` on 23 screens by construct, and by the `for` loops on none.
 * Where a check can be phrased either way, `some` is free insurance.
 */
let controlsSeen = 0;
/**
 * The notifications screen must always say SOMETHING about this device —
 * exactly one of the four states, never none and never two.
 *
 * Deliberately browser-independent: headless Chromium reports permission as
 * 'denied' and the full browser reports 'default', so asserting a particular
 * message would only ever hold under one of them. What must hold under both is
 * that the section exists at all. Without this the sweep merely photographs
 * whatever renders, and the whole control could vanish with every check green.
 */
async function checkDeviceState(page, tag) {
  // FROM THE APP'S OWN STRINGS, not a copy. A restated sentence drifts, and the
  // check then passes by finding something the screen stopped saying — or, as
  // here, fails for a wording change that was fine.
  const messages = Object.values(PUSH_DEVICE_MESSAGE);
  const shown = [];
  for (const m of messages) {
    // `.filter({ visible: true })`, like every other locator in this file. Home's
    // push nudge renders the SAME sentence as this screen, native-stack keeps
    // Home mounted-but-hidden and FIRST in document order, so `.first()` picked
    // the invisible copy and the check reported seeing nothing.
    if (
      await page
        .getByText(m, { exact: false })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      shown.push(m);
    }
  }
  check(
    `${tag} / notifications says exactly one thing about this device`,
    shown.length === 1,
    `saw ${shown.length}: ${shown.join(' | ') || '(none)'}`,
  );
}

function check(name, ok, detail = '') {
  results.push({ name, ok, ...(ok ? {} : { detail }) });
  // The detail describes the FAILURE, so it prints only when there is one.
  // Appended to a passing line it reads as the opposite of what happened.
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

/**
 * EVERY LAYOUT NUMBER COMES FROM THE SOURCE, never from a copy here. A constant
 * restated in the test that checks it drifts from the thing it is testing.
 */
const themeSrc = await readFile(resolve(ROOT, 'app/src/theme/index.ts'), 'utf8');
const CONTENT_MAX_WIDTH = Number(themeSrc.match(/CONTENT_MAX_WIDTH\s*=\s*(\d+)/)?.[1]);
if (!CONTENT_MAX_WIDTH) throw new Error('CONTENT_MAX_WIDTH is no longer in app/src/theme/index.ts');

/**
 * THE CAPS A SCREEN MAY CHOOSE FROM — read out of the theme, not restated.
 *
 * A reading column and a card grid want opposite things from a 1500px window:
 * prose capped for line length, collections given the room. So a screen
 * declares which kind it is (`Screen width="read" | "list"`) and this check
 * accepts either declared maximum.
 *
 * That is weaker by exactly one bit — it cannot tell a list screen that claimed
 * the wrong cap — and not weaker in the way that matters: a column past EVERY
 * cap, or one that fails to centre, still fails. The alternative was for the
 * sweep to know which screen is which kind, which is the restatement this file
 * exists to avoid.
 */
const LIST_MAX_WIDTH = Number(themeSrc.match(/list:\s*(\d+)/)?.[1]);
if (!LIST_MAX_WIDTH) throw new Error('LAYOUT_WIDTHS.list is no longer in app/src/theme/index.ts');
/*
 * THE PLAYER'S THIRD WIDTH, read from the player rather than restated.
 *
 * It does not use `Screen` at all: a transport, a scrub bar and a rate row are a
 * media column, narrower than prose, and `theme/index.ts` calls it out as a
 * deliberate third maximum with exactly one member. The floor check below needs
 * it or the one screen in the app that is meant to be narrow reads as the one
 * screen that failed to take the room.
 */
const playerSrc = await readFile(resolve(ROOT, 'app/src/screens/PlayerScreen.tsx'), 'utf8');
const PLAYER_MAX_WIDTH = Number(playerSrc.match(/maxWidth:\s*(\d+)/)?.[1]);
if (!PLAYER_MAX_WIDTH) throw new Error('the player column cap is no longer in PlayerScreen.tsx');
const COLUMN_CAPS = [PLAYER_MAX_WIDTH, CONTENT_MAX_WIDTH, LIST_MAX_WIDTH];

/**
 * The dialog's own cap — a different measurement from the screen columns, read
 * from the component rather than restated.
 *
 * A sheet is not a column in a scroll view: it is a panel centred over one, and
 * `Sheet.tsx` bounds it at a width narrower than every screen cap. So the six
 * screens toured with a sheet OPEN are checked against this instead.
 */
const sheetSrc = await readFile(resolve(ROOT, 'app/src/components/Sheet.tsx'), 'utf8');
// The panel's OWN block, cut at its closing brace — not the first `maxWidth:`
// after `panel:`, which is inside the block only by ordering. See the note in
// `functions/test/unit/dialogWidth.test.ts`, which reads it the same way and is
// where the number itself is argued.
const panelBlock = sheetSrc.slice(sheetSrc.indexOf('panel: {')).split('\n  },')[0];
const SHEET_MAX_WIDTH = Number(panelBlock.match(/maxWidth:\s*(\d+)/)?.[1]);
if (!SHEET_MAX_WIDTH) throw new Error('the panel width cap is no longer in Sheet.tsx');

/**
 * The width the chrome changes shape at — read, like the caps, rather than
 * restated. The sweep has to straddle it or it silently stops exercising the
 * rail, which is half the layouts in the app.
 */
const WIDE_BREAKPOINT = Number(themeSrc.match(/WIDE_BREAKPOINT\s*=\s*(\d+)/)?.[1]);
if (!WIDE_BREAKPOINT) throw new Error('WIDE_BREAKPOINT is no longer in app/src/theme/index.ts');

/**
 * Widths chosen to STRADDLE BOTH BREAKPOINTS, not to look thorough: a bug on one
 * side of either is invisible from the other. A narrow phone, an ordinary phone,
 * one exactly at the reading cap, one just past the point the rail appears, and
 * a desktop. Both numbers come from the theme, so moving either moves these.
 */
const WIDTHS = process.env.SWEEP_WIDTHS
  ? process.env.SWEEP_WIDTHS.split(',').map(Number)
  : [320, 390, CONTENT_MAX_WIDTH, WIDE_BREAKPOINT + 124, 1440];
/** Real descriptors add DPR, touch and a mobile UA, which plain widths do not. */
const PROFILES = FULL
  ? [
      ['iphone-se', devices['iPhone SE']],
      ['pixel-7', devices['Pixel 7']],
      ['ipad-mini', devices['iPad Mini']],
    ]
  : [];

// A clean folder, so the report (`sabeel-ci screens-report`) shows this run's
// screens and no other's, and the checks beside them however the run ends.
await rm(SHOTS, { recursive: true, force: true });
await mkdir(SHOTS, { recursive: true });
process.on('exit', () => writeFileSync(join(SHOTS, 'results.json'), JSON.stringify(results, null, 1)));
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

// ---- the world -----------------------------------------------------------

/**
 * The fixture lives in `lib/seed-world.mjs`, so this file is checks rather than
 * three hundred lines of setup in front of them. Its docblock says what the
 * content is chosen to break.
 */
await resetEmulators();
const browser = await chromium.launch();
const world = await seedWorld({ db, auth, browser, base: BASE });
const {
  STUDENT, DISABLED_STUDENT, DELETED_STUDENT, STUDENT_PASSWORD, missed, dueSoon, blocking, archived, LONG_COURSE_NAME, UNENROLLED,
  HISTORY_ROW, HISTORY_ROW_MANAGED, PENDING_DATE, TO_GRADE, RULES_UNSEEN,
} = world;

/**
 * What `listZoomRecordings` answers in this sweep — see the `zoom-import`
 * visit. Instants are written in UTC from the pending session's date, so the
 * Houston date of each is fixed whichever side of a DST change the run falls.
 */
function zoomRows() {
  const at = (days, time) => `${addDays(PENDING_DATE, days)}T${time}Z`;
  const file = (fileId, format, minutes, imported = null) => ({
    fileId, format, sizeBytes: minutes * (format === 'audio' ? 560_000 : 2_000_000), ready: true,
    imported: imported ? { recordingId: 'sw-s1r', sessionId: 'sw-s1', courseName: imported } : null,
  });
  const segment = (startTime, minutes, files) => ({ startTime, durationSec: minutes * 60, files });
  const meeting = (meetingUuid, segments) => ({
    meetingUuid, topic: 'Quran Immersion Fall', startTime: segments[0].startTime,
    durationSec: segments.reduce((n, x) => n + x.durationSec, 0), segments,
  });
  return [
    // 7:30 pm CDT / 6:30 pm CST on the session's date: video and audio.
    meeting('zoom-evening', [segment(at(1, '00:30:00'), 75, [file('eve-spk', 'speaker', 75), file('eve-aud', 'audio', 75)])]),
    // 1 pm CDT / noon CST on it: every format, recording restarted twice —
    // the second stretch short, the third still processing in Zoom.
    meeting('zoom-day', [
      segment(at(0, '18:00:00'), 65, [file('day-spk', 'speaker', 65), file('day-sld', 'slides', 65), file('day-aud', 'audio', 65)]),
      segment(at(0, '19:06:00'), 1, [file('day2-aud', 'audio', 1)]),
      segment(at(0, '19:10:00'), 20, [{ ...file('day3-aud', 'audio', 20), ready: false }]),
    ]),
    // A test click: hidden as under 2 minutes.
    meeting('zoom-blip', [segment(at(0, '17:40:00'), 1, [file('blip-aud', 'audio', 1)])]),
    meeting('zoom-earlier', [
      segment(at(-6, '00:30:00'), 136, [file('earlier-spk', 'speaker', 136), file('earlier-aud', 'audio', 136, 'Arabic I & Qur’anic Morphology — Tuesday Evening Section')]),
    ]),
  ];
}

// ---- assertions ------------------------------------------------------------

/**
 * Every measurement below is against the LAYOUT viewport, not the window.
 *
 * This is a choice of PROPERTY, not a guard — `clientWidth` and
 * `getBoundingClientRect().width` are the same amount of code, and the layout
 * box is simply the thing a layout question is about. So it stays even though
 * the two agree here: measured on this headless Chromium, the scrollbar is an
 * overlay and the inset is zero, in both scrollbar modes, so the naive form
 * would pass identically. Nothing below is defending against anything.
 *
 * Where a classic scrollbar IS in effect — another OS, a headed run — the two
 * checks here would fail in opposite directions: the centring check gets a false
 * positive, and the sideways-bleed check a false NEGATIVE hiding up to ~15px of
 * real overflow. Reading the right box makes both questions well-posed on any
 * runner, which is a better reason to do it than the failure it avoids.
 */
const layoutFaults = (page, readOnly = false) =>
  page.evaluate((readOnly) => {
    const vw = document.documentElement.clientWidth;
    const faults = [];

    // The PAGE must never widen. Inner horizontal scrollers, where this app has
    // any, are their own elements — this is the classic responsive failure a
    // top-of-page screenshot never reveals.
    const bleed = document.documentElement.scrollWidth - vw;
    if (bleed > 1) faults.push(`page scrolls sideways by ${bleed}px`);

    /**
     * The part of an element you can actually SEE.
     *
     * `getBoundingClientRect` reports where an element would be, not what is
     * visible: a roster row scrolled out of its list still returns its full
     * height, so it geometrically "overlaps" whatever sits below the list.
     * Clipping an ancestor does not shrink the rect, so it is clipped here.
     */
    const visibleRect = (el) => {
      let r = el.getBoundingClientRect();
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (!/hidden|auto|scroll/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
        const c = n.getBoundingClientRect();
        r = {
          left: Math.max(r.left, c.left),
          right: Math.min(r.right, c.right),
          top: Math.max(r.top, c.top),
          bottom: Math.min(r.bottom, c.bottom),
        };
      }
      return {
        left: Math.max(r.left, 0),
        right: Math.min(r.right, vw),
        top: Math.max(r.top, 0),
        bottom: Math.min(r.bottom, window.innerHeight),
      };
    };
    const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

    /** The nearest positioned ancestor — the header, a confirmation that has
     *  taken over its card, or the page. */
    const layerOf = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') return n;
      }
      return document.body;
    };

    // `role="tab"` IS IN THE LIST, and its absence was a hole rather than an
    // omission: react-native-web maps most roles onto real elements but has none
    // for `tab`, so a `Segmented` renders a bare <div role="tab"> that matched
    // nothing here. Two of this app's switches — People's Students/Staff and the
    // attendance report's by-session/by-student — moved into that hole when they
    // adopted the shared control, and stopped being measured for overlap, right-
    // edge clipping and touch size on four toured screens.
    const SELECTOR =
      '[role="button"], [role="switch"], [role="radio"], [role="tab"], [role="link"], button';
    const els = [...document.querySelectorAll(SELECTOR)].filter((e) => area(visibleRect(e)) > 4);
    /*
     * STARVATION IS A FAULT, PER SCREEN.
     *
     * Overlap and right-edge below are `for` loops over `els`, and a `for` over
     * an empty set is silence — they would return a clean bill of health having
     * looked at nothing, on every screen, for good. Measured in the sibling
     * harness: starving this selector left 23 screens reporting zero layout
     * faults while examining zero elements.
     *
     * Per screen rather than per run, and reported as a fault rather than as its
     * own check, so it names WHERE and costs no extra line. Every screen in this
     * app has controls; one with none is an anomaly, not a quiet day.
     */
    /*
     * CHROME DOES NOT COUNT. The navigation bar puts three to five buttons on
     * every screen in the app, and the docked player adds more — so counting
     * them made this guard true everywhere and unable to fire again. What it is
     * watching for is a SCREEN whose own controls the selector cannot see.
     */
    const chrome = (e) =>
      /^tab-/.test(e.getAttribute('data-testid') || '') ||
      !!e.closest('[data-testid="mini-player"]') ||
      // AND THE HEADER'S BACK, which every pushed screen has and which this
      // file already knows is a `role="link"` rather than a button (see
      // `escapes`). Counting it left the guard unable to fire on the 33 pushed
      // screens — the ones whose own controls it exists to watch for.
      /(^|,\s*)(go\s+)?back$/i.test(
        (e.getAttribute('aria-label') || e.textContent || '').trim(),
      );
    if (readOnly === true) {
      // A screen DECLARED as read-only must not quietly grow a control the
      // checks below would then be the only thing watching. The guard runs in
      // both directions, so the declaration cannot rot.
      if (els.filter((e) => !chrome(e)).length > 0) {
        faults.push('declared read-only but rendered a control of its own');
      }
    } else if (readOnly === false && els.filter((e) => !chrome(e)).length === 0) {
      faults.push(
        'examined NO controls of its own — the overlap and right-edge checks are inert here, not passing',
      );
    }
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || '?').trim().slice(0, 24);

    for (let i = 0; i < els.length; i += 1) {
      for (let j = i + 1; j < els.length; j += 1) {
        const a = els[i];
        const b = els[j];
        // Nesting is legitimate (a control inside a pressable row); two
        // INDEPENDENT controls sharing pixels is not.
        if (a.contains(b) || b.contains(a)) continue;
        // Neither is overlap ACROSS LAYERS: the header is its own layer and
        // content scrolls under it by design. Only controls laid out against
        // each other are worth comparing.
        if (layerOf(a) !== layerOf(b)) continue;
        const ra = visibleRect(a);
        const rb = visibleRect(b);
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 1 && oy > 1) {
          faults.push(`"${name(a)}" overlaps "${name(b)}" by ${Math.round(ox)}x${Math.round(oy)}px`);
        }
      }
    }

    /*
     * NOTHING MAY BE CLIPPED BY THE RIGHT EDGE.
     *
     * Distinct from "the page scrolls sideways": a row can overflow inside a
     * clipping ancestor, so the page width never changes and the sideways check
     * stays green while a control is sliced in half at the boundary. Rows here
     * pin a name that may not shrink beside actions that may not shrink
     * (`rowItem`, `rowHeadPinned` in ui.tsx), which is exactly that shape.
     */
    for (const e of els) {
      const raw = e.getBoundingClientRect();
      if (raw.right > vw + 1 && area(visibleRect(e)) > 4) {
        faults.push(`"${name(e)}" is clipped by the right edge (${Math.round(raw.right - vw)}px past)`);
      }
    }

    /*
     * NO TEXT RUNS OFF ITS CARD. The check above watches controls; a sentence
     * that does not wrap is the same defect in prose. "Was due 2026-10-10 ·
     * accepted until 2026-10-17" ran past a 320px card's edge with every
     * control-based check green. Text inside a SCROLLING ancestor (a chip row
     * that scrolls sideways) is meant to go past the edge, so only the viewport
     * and ancestors that hide overflow without scrolling count.
     */
    const textClip = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 0;
      let limit = vw;
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (/auto|scroll/.test(cs.overflowX)) return 0;
        if (/hidden|clip/.test(cs.overflowX)) limit = Math.min(limit, n.getBoundingClientRect().right);
      }
      return r.right - limit;
    };
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!own || getComputedStyle(el).textOverflow === 'ellipsis') continue;
      const past = textClip(el);
      if (past > 1) {
        faults.push(`text "${el.textContent.trim().slice(0, 30)}" runs ${Math.round(past)}px past its edge`);
      }
    }

    /*
     * NO BUTTON'S LABEL BREAKS INSIDE A WORD — at the text size a phone can be
     * set to. "Post" came out "Po / st" on a staff phone with larger text than
     * this sweep's, in a button crushed into half of a shared cell; at the
     * default size it fitted, so nothing here could see it. So the labels are
     * measured with every font a third larger (the large-text setting phones and
     * Chrome offer), word by word: a word whose letters land on two lines is a
     * label broken mid-word. Only LABELS are read — a control whose text runs
     * past 40 characters is a row carrying content (a name and an email), and
     * a long address in it may rightly wrap anywhere — and a break after a
     * hyphen is a break between words. Links are left out for the same reason.
     * Every font is put back before anything else is measured.
     */
    const LARGE_TEXT = 1.3;
    const BUTTONS = '[role="button"], [role="switch"], [role="radio"], [role="tab"], button';
    const scaled = [...document.querySelectorAll('body *')].map((el) => [
      el,
      el.style.getPropertyValue('font-size'),
      el.style.getPropertyPriority('font-size'),
      parseFloat(getComputedStyle(el).fontSize),
    ]);
    for (const [el, , , size] of scaled) if (size) el.style.setProperty('font-size', `${size * LARGE_TEXT}px`, 'important');
    for (const control of els.filter((e) => e.matches(BUTTONS) && e.textContent.trim().length <= 40)) {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const word of node.textContent.matchAll(/[^\s-]+-?/g)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
          if (lines.size > 1) {
            faults.push(`"${control.textContent.trim().slice(0, 30)}" breaks inside "${word[0]}" with large text`);
          }
        }
      }
    }
    for (const [el, value, priority] of scaled) {
      if (value) el.style.setProperty('font-size', value, priority);
      else el.style.removeProperty('font-size');
    }

    /*
     * A FIXED-FORMAT CONTROL SQUASHED NARROWER THAN ITS OWN WIDGET.
     *
     * The only check here sensitive to ABSOLUTE width, and it exists because
     * every other one is relative and therefore blind to this: a control can sit
     * inside its container, overlap nothing, clip nothing, and still be too
     * narrow to use.
     *
     * Scoped deliberately to controls whose content CANNOT be scrolled to. A
     * text field holding more than fits is ordinary — it scrolls, and it scrolls
     * itself as you type — so flagging that would fire on every long email
     * address in the app and the check would be deleted inside a week. A date,
     * time or number input renders a fixed widget and a `select` renders its
     * longest option; when the box is narrower than that, part of the control is
     * simply unreachable. That is always a bug and never a clamp.
     *
     * The sibling app shipped a date field squashed to "08" at 320px and correct
     * at every width above it. No relative check noticed, in either harness.
     */
    const FIXED_FORMAT =
      'input[type="date"], input[type="time"], input[type="datetime-local"], ' +
      'input[type="month"], input[type="week"], input[type="number"], select';
    let fixedFormatSeen = 0;
    for (const el of document.querySelectorAll(FIXED_FORMAT)) {
      if (area(visibleRect(el)) < 4) continue;
      fixedFormatSeen += 1;
      /*
       * Measured against the control's OWN min-content width, by cloning it,
       * letting the clone size to its content, and reading that back.
       *
       * The obvious signal — `scrollWidth > clientWidth` — does not work, and
       * failing to check that shipped an inert check for one run. Chromium draws
       * a date input's widget in a UA shadow root with `overflow: hidden`, so a
       * date field squashed from 166px to 38px reports scrollWidth === clientWidth
       * and looks perfectly healthy. (It does work for `select`, which is what
       * made the idea plausible.) Min-content discriminates for both: 0px short
       * when healthy, 128px short for that same squashed date field.
       *
       * The clone is appended and removed inside one synchronous evaluate, so
       * React never observes it and the page is unchanged by the time the
       * screenshot is taken.
       */
      const probe = el.cloneNode(true);
      probe.style.maxWidth = 'none';
      probe.style.width = 'min-content';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      el.parentElement.appendChild(probe);
      const needs = probe.getBoundingClientRect().width;
      probe.remove();

      const shortfall = needs - el.getBoundingClientRect().width;
      if (shortfall > 2) {
        const label =
          el.getAttribute('aria-label') ||
          el.labels?.[0]?.textContent ||
          el.previousElementSibling?.textContent ||
          `${el.tagName.toLowerCase()}[${el.type}]`;
        faults.push(
          `"${label.trim().slice(0, 24)}" is ${Math.round(shortfall)}px narrower than ` +
            'its content needs — a fixed-format control cannot be scrolled to',
        );
      }
    }

    /*
     * NO INTERACTIVE CONTENT NESTED INSIDE A <button>.
     *
     * `accessibilityRole="button"` adds no ARIA attribute on web —
     * react-native-web maps it to a real <button> ELEMENT. Put that on a
     * Pressable wrapping other things and the result is invalid HTML, which the
     * browser resolves by treating keys pressed in the nested control as
     * activating the button. Checked structurally, because the shape is what is
     * wrong and it can be reintroduced anywhere a Pressable gains a role and a
     * child — this app has switch rows, confirmation wrappers and roster rows
     * that all wrap other controls.
     */
    for (const b of document.querySelectorAll('button')) {
      const nested = b.querySelector('input, textarea, select, button, a[href], [contenteditable="true"]');
      if (nested) {
        faults.push(
          `<button> "${name(b)}" contains a nested <${nested.tagName.toLowerCase()}> — ` +
            'invalid HTML; keys pressed inside it can activate the button',
        );
      }
    }

    return { faults: [...new Set(faults)], fixedFormat: fixedFormatSeen, controls: els.length };
  }, readOnly);

/**
 * Can you LEAVE this screen without the browser's Back?
 *
 * Every screen carries the bar (on a phone) or the rail (on a wide screen), and
 * a pushed one carries the header's Back as well — so the question is whether it
 * has EITHER, and a tab root, which is never pushed, correctly has no Back at
 * all. A sheet is not a screen and has no header; its exit is its own dismiss.
 *
 * Both halves still matter. `nav` alone would pass a pushed screen that lost
 * its Back, leaving no way back to where you came from — only a way to start
 * over at a tab root, which is not the same thing.
 */
/**
 * Navigation labels drawn short of their own text. A tab name is one line by
 * design, so a name longer than its cell is clipped to "Recordi…" rather than
 * wrapped — and every geometric check above passes, since nothing overflows
 * the cell that clips it.
 */
const cutNavLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tab-"]')]
      .filter((tab) => tab.getBoundingClientRect().width > 0)
      // The label is the one-line text, which clips with an ellipsis; the badge
      // overhangs its icon on purpose and is not a label.
      .filter((tab) =>
        [...tab.querySelectorAll('*')].some(
          (el) => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1,
        ),
      )
      .map((tab) => tab.textContent.trim()),
  );

const escapes = (page) =>
  page.evaluate(() => {
    const shown = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
    /*
     * WITHIN THE SHEET, when a sheet is open.
     *
     * react-native-web portals a `Modal` to the body and leaves the app root
     * rendered and queryable underneath it, so a whole-document search finds the
     * BACKGROUND screen's Back arrow and its tab bar — neither of which a person
     * looking at a modal dialog can reach. A create sheet that lost its Cancel
     * button entirely still passed.
     */
    const scope = document.querySelector('[data-testid="sheet-panel"]') ?? document;
    /*
     * The header Back is an <a>, NOT a <button>.
     *
     * `PlatformPressable` renders `role="link"` whenever it has an `href`, and
     * the navigator hands it one because this app has a linking config — which
     * is also what makes the browser's own Back work. Looking only at buttons
     * reported every pushed screen in the app as a dead end, which is a check
     * failing on its own query rather than on the thing it is checking.
     */
    const controls = [
      ...scope.querySelectorAll('[role="button"], [role="link"], button, a[href]'),
    ].filter(shown);
    return {
      // "Go back" when there is no previous title, "<Title>, back" when there
      // is — both from @react-navigation/elements.
      back: controls.some((e) => /(^|,\s*)(go\s+)?back$/i.test(label(e))),
      // A sheet is not a screen and has no header. Its exit is its own dismiss
      // button, which is as real an escape as a Back arrow.
      cancel: controls.some((e) => /^(cancel|close)$/i.test(label(e))),
      // A gate stands in place of the whole app, so it has neither Back nor
      // the bar: its way out is signing out.
      signOut: controls.some((e) => /^sign out$/i.test(label(e))),
      // The persistent chrome. Every screen has it; only a tab root may rely on
      // it as its ONLY exit — and it has to be VISIBLE, like the others: a bar
      // rendered at zero height would otherwise satisfy "has a way out".
      nav: controls.some((e) => e.getAttribute('data-testid') === 'tab-more'),
      // Whether this screen is a sheet at all, so the caller knows which
      // question it just answered.
      sheet: scope !== document,
    };
  });

/**
 * THE COLUMN, MEASURED rather than assumed.
 *
 * Every screen is a scroll view whose content container caps at
 * one of the declared maxima and centres. Below that width the column must be
 * full-bleed — losing that is how a phone gets margins it cannot afford — and at
 * or above it the column must actually cap AND actually centre, because
 * `maxWidth` without `alignSelf` leaves a desktop page hugging the left and
 * looks deliberate enough that nobody files it.
 *
 * The container is found structurally, as the scroll view's only child:
 * `contentContainerStyle` lands on a node React Native gives no way to label,
 * so there is no testID to ask for. A screen held still has one
 * (`screen-fill`), being a view of its own.
 */
const contentColumn = (page) =>
  page.evaluate(() => {
    /*
     * THE PANEL, when a sheet is open — a different shape with a different rule.
     *
     * `Modal` is portaled to the body with the app root left rendered beneath
     * it, and the sheet's own ScrollView is `flexGrow: 0` inside a 420px panel,
     * so the largest-scroller-by-area sort always picked the SCREEN BEHIND THE
     * SHEET. Six of this tour's visits exist precisely to measure a sheet, and
     * all six were measuring the page they were opened from: a panel that lost
     * its width cap and went full-bleed at 1440 produced no failure at all.
     */
    const panel = document.querySelector('[data-testid="sheet-panel"]');
    if (panel) {
      const box = panel.getBoundingClientRect();
      // MEASURED off the backdrop, not restated: the gutter it holds the panel
      // off the edges by is what "all the room there is" means at a width below
      // the cap.
      const pad = parseFloat(getComputedStyle(panel.parentElement).paddingLeft) || 0;
      return {
        sheet: true,
        pad,
        outerLeft: 0,
        outerWidth: document.documentElement.clientWidth,
        left: box.left,
        width: box.width,
      };
    }
    /*
     * A SCREEN HELD STILL (`Screen fill`, a help film) has no scroll view: its
     * column is the labelled content view, measured against the canvas it
     * fills, by the same rules.
     */
    const still = [...document.querySelectorAll('[data-testid="screen-fill"]')].find((el) => el.checkVisibility());
    if (still) {
      const canvas = still.parentElement;
      const box = canvas.getBoundingClientRect();
      const inner = still.getBoundingClientRect();
      return { outerLeft: box.left + canvas.clientLeft, outerWidth: canvas.clientWidth, left: inner.left, width: inner.width };
    }
    const scrollers = [...document.querySelectorAll('div')].filter((el) => {
      const cs = getComputedStyle(el);
      return /auto|scroll/.test(cs.overflowY) && el.firstElementChild && el.clientHeight > 80;
    });
    if (!scrollers.length) return null;
    scrollers.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
    const el = scrollers[0];
    const box = el.getBoundingClientRect();
    const inner = el.firstElementChild.getBoundingClientRect();
    // clientWidth/clientLeft, not the bounding rect: a classic scrollbar is
    // inside the border box and is not space the column could have used.
    return {
      outerLeft: box.left + el.clientLeft,
      outerWidth: el.clientWidth,
      left: inner.left,
      width: inner.width,
    };
  });

function columnFault(col, caps) {
  if (!col) return 'no scrolling content column found';
  const { outerLeft, outerWidth, left, width } = col;
  /*
   * A SHEET IS BOUNDED AND CENTRED, not capped-or-full-bleed.
   *
   * It floats over the page rather than filling a scroll view, so the column
   * rules below do not describe it: there is no "reach the cap" to satisfy, and
   * the backdrop's padding means it is never full-bleed even on a phone. What it
   * owes is that it stays inside its declared maximum, inside the viewport, and
   * centred.
   */
  if (col.sheet) {
    /*
     * ITS CAP, OR ALL THE ROOM THERE IS — both directions, like the column
     * checks below. Only the ceiling would let a panel that shrank to 200px on
     * a laptop pass; only the floor would let one that lost its cap pass.
     *
     * `SHEET_MAX_WIDTH` is parsed out of `Sheet.tsx`, so this cannot judge
     * whether 420 is a sensible dialog width — a cap raised to 2000 moves both
     * sides of this comparison at once. That is `app/src/theme/layout.test.ts`'s
     * job, and it is the same division of labour as `COLUMN_CAPS`: measurement
     * here, argument there.
     */
    const expected = Math.min(SHEET_MAX_WIDTH, outerWidth - 2 * col.pad);
    if (Math.abs(width - expected) > 2) {
      return `sheet is ${Math.round(width)}px where ${Math.round(expected)}px was the room it had`;
    }
    const off = left - (outerWidth - width) / 2;
    return Math.abs(off) > 2 ? `sheet sits ${Math.round(off)}px off centre` : '';
  }
  const smallest = Math.min(...caps);
  const largest = Math.max(...caps);
  // Narrower than every cap: the column must fill it. Nothing to centre.
  if (outerWidth < smallest) {
    return width < outerWidth - 2
      ? `column is ${Math.round(width)}px inside a ${Math.round(outerWidth)}px viewport — should be full-bleed`
      : '';
  }
  if (width > largest + 1) {
    return `column is ${Math.round(width)}px, past the widest ${largest}px cap`;
  }
  /*
   * AND IT HAS TO REACH ONE OF THEM. Only the ceiling was checked, so a column
   * could be any width at all below the smallest cap and still pass: dropping
   * `CONTENT_MAX_WIDTH` from 720 to 420 would render every reading screen as a
   * 420px ribbon in a 1364px window, green at all five widths — and green
   * because `COLUMN_CAPS` is parsed out of the theme, so the expectation moves
   * with the defect. A column that had the room and did not take it is the
   * "stretched phone layout" failure seen from the other side.
   */
  const nearest = caps.reduce((a, c) => (Math.abs(c - width) < Math.abs(a - width) ? c : a));
  if (width < Math.min(nearest, outerWidth) - 2) {
    return `column is ${Math.round(width)}px in a ${Math.round(outerWidth)}px viewport — short of the ${nearest}px cap it should reach`;
  }
  // Between two caps, a screen using the wider one is legitimately full-bleed.
  if (width > outerWidth - 2) return '';
  const offset = left - outerLeft;
  const centred = (outerWidth - width) / 2;
  return Math.abs(offset - centred) > 2
    ? `column sits ${Math.round(offset)}px from the left, not the ${Math.round(centred)}px that centres it`
    : '';
}

/**
 * THE PAGE LAID OUT AT THE WIDTH IT WAS ASKED FOR.
 *
 * Everything else in this file measures the DOM against the DOM, which makes the
 * checks internally consistent and says nothing about *which width* they ran at.
 * The width came from a Playwright viewport option and was believed. If one ever
 * failed to apply, every geometric check would still pass, every screenshot
 * would be mislabelled, and "a thousand checks across five widths" would be a
 * sentence about nothing — the file's own headline rule, one level up, at the tour's
 * premise rather than at its steps.
 *
 * So the requested width is ASSERTED rather than threaded through as an
 * assumption. Once per context and before the tour, not per screen: a wrong
 * viewport should fail in one honest line ahead of the geometry, rather than
 * after a whole tour has been measured against the wrong reference.
 *
 * `documentElement.clientWidth` rather than `innerWidth` for the same reason as
 * everywhere else — it is the layout box, so on a runner whose scrollbars are
 * classic rather than overlay this reports the real divergence instead of hiding
 * it.
 */
const laidOutAt = (page) =>
  page.evaluate(() => ({
    layout: document.documentElement.clientWidth,
    window: window.innerWidth,
  }));

const smallTargets = (page) =>
  page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll(
        '[role="button"], [role="switch"], [role="radio"], [role="tab"], button',
      )]
        .map((e) => ({
          n: (e.getAttribute('aria-label') || e.textContent || '?').trim().slice(0, 18),
          r: e.getBoundingClientRect(),
        }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.height < 44)
        .map((x) => `${x.n} ${Math.round(x.r.height)}px`),
    ),
  ]);

/** Drive the screen's scroll view to the bottom, and say whether it moved. */
const scrollToBottom = (page) =>
  page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('div')].filter((el) => {
      const cs = getComputedStyle(el);
      return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 8;
    });
    if (!scrollers.length) return false;
    scrollers.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
    scrollers[0].scrollTop = scrollers[0].scrollHeight;
    return true;
  });

// ---- the tour --------------------------------------------------------------

/**
 * Back to the first tab, in one tap.
 *
 * The bar is always on screen and a tab always resets the stack, so this is both
 * faster than walking Back and closer to what a person does. The Back-walk
 * survives as the fallback for the one case the bar cannot answer — a screen
 * that failed to render the chrome at all, which is itself a fault the
 * `has a way out` check reports.
 */
async function goHome(page, homeMarker) {
  /*
   * DISMISS ANY OPEN SHEET FIRST.
   *
   * A modal's backdrop covers the whole viewport, tab bar included, so the tab
   * is visible, enabled and stable — and every click on it lands on the
   * backdrop. Playwright retries for its full timeout and then reports the
   * intercepting element by class name, which says nothing about which sheet.
   * Escape is what `onRequestClose` is wired to on web.
   */
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(150);
  const firstTab = byId(page, homeMarker);
  if (await firstTab.isVisible().catch(() => false)) {
    await firstTab.click();
    await page.waitForTimeout(350);
    return;
  }
  for (let i = 0; i < 16; i += 1) {
    const back = backButton(page);
    if (!(await back.isVisible().catch(() => false))) break;
    await back.click();
    await page.waitForTimeout(350);
  }
  if (await firstTab.isVisible().catch(() => false)) return;
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await firstTab.waitFor({ timeout: 60_000 });
}

/**
 * One screen: reach it, measure it, photograph it, then measure it again at the
 * BOTTOM.
 *
 * The second pass is not thoroughness for its own sake. Overlap is judged on
 * what is visible, so a check that only ever looks at the top of a screen cannot
 * see the end of a fourteen-row roster or the controls below the player's fold —
 * which on a 320px phone is most of the app. The screenshot is taken between the
 * two, so a failure always has a picture of what was measured beside it.
 */
/**
 * A LOADING SCREEN IS NOT THE SCREEN. Every placeholder the app shows while it
 * reads ("Counting the work…", "Checking your courses…", "Loading…") is a verb
 * ending in an ellipsis, and the sweep once photographed and measured a course
 * screen with its assignments still "Counting the work…" — the layout checked
 * was not the one a teacher sees. Wait for every visible placeholder to go;
 * return the ones still showing after 15 s, which is a screen stuck loading.
 */
const PLACEHOLDER = /^(Loading|Checking|Counting|Saving|Sending|Uploading|Waiting)\b.*…$/;
async function settled(page) {
  const showing = () => page.evaluate((source) => {
    const pattern = new RegExp(source);
    const seen = new Set();
    for (const node of document.querySelectorAll('body *')) {
      if (node.children.length || !node.offsetParent) continue;
      const text = node.textContent.trim();
      if (pattern.test(text)) seen.add(text);
    }
    return [...seen];
  }, PLACEHOLDER.source);
  for (let waited = 0; waited < 15_000; waited += 250) {
    if (!(await showing()).length) return [];
    await page.waitForTimeout(250);
  }
  return showing();
}

function visitor(page, tag, homeMarker, counter) {
  /*
   * `anchor` IS WHAT SAYS THE TOUR ARRIVED.
   *
   * `tap` waits for the BUTTON to appear, not for the screen the button leads
   * to — so a slow render, or a row that resolved to the wrong record, gave a
   * green run of geometric checks against whatever happened to be on screen,
   * saved under the name of the screen that was meant to be there. A testID only
   * the destination renders closes that: it is the difference between "this
   * layout is fine" and "this layout, on this screen, is fine".
   */
  return async function visit(name, go, anchor) {
    // Every call passes one. The parameter stays optional only so a new visit
    // fails on the anchor rather than on a signature.
    await goHome(page, homeMarker);
    await go();
    if (anchor) {
      await byId(page, anchor)
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      check(
        `${tag} / ${name} is the screen it says it is`,
        await byId(page, anchor).isVisible().catch(() => false),
        `${anchor} never appeared`,
      );
    }
    await page.waitForTimeout(450);
    const stillLoading = await settled(page);
    check(`${tag} / ${name} finished loading`, stillLoading.length === 0, `still showing ${stillLoading.join('; ')}`);

    const readOnly = READ_ONLY_SCREENS.has(name);
    const top = await layoutFaults(page, readOnly);
    fixedFormatSeen += top.fixedFormat;
    controlsSeen += top.controls;
    check(`${tag} / ${name}`, top.faults.length === 0, top.faults.join('; ').slice(0, 200));

    const out = await escapes(page);
    // A sheet's only exit is its OWN dismiss — the Back arrow and the tab bar
    // behind it are unreachable while the modal is up, and are no longer what
    // this asks about. A tab root's exit is the bar; a pushed screen's is Back.
    const root = TAB_ROOTS.has(name);
    const gate = GATE_SCREENS.has(name);
    /*
     * ONE ANSWER PER KIND OF SCREEN, and no substitutions.
     *
     * A sheet's exit is its own dismiss; a tab root's is the bar; a PUSHED
     * screen's is the header Back and nothing else. `out.back || out.cancel` let
     * an inline editor's Cancel stand in for the Back arrow — and `escapes()`
     * matches any visible Cancel anywhere on the page, so the three screens
     * toured with an editor OPEN (`session-editing`, `ledger-override`,
     * `course-remove-confirm`) were satisfied by a control that only closes the
     * editor. Removing the header from those screens would strand a staff member
     * on a phone with no way back to the course, and all three would stay green
     * at all five widths — which is exactly what this check's own docblock says
     * it exists to prevent.
     */
    check(
      `${tag} / ${name} has a way out`,
      out.sheet ? out.cancel : gate ? out.signOut : root ? out.nav : out.back,
      out.sheet
        ? 'a sheet with nothing in it that dismisses the sheet'
        : gate
          ? 'a gate with no Sign out'
          : root
            ? 'a tab root with no navigation bar'
            : 'no Back in the header — an editor’s Cancel is not a way off the screen',
    );

    // The bar and the rail are the same on every screen of a population, so
    // each tab root asks once.
    if (root && !out.sheet) {
      const cut = await cutNavLabels(page);
      check(`${tag} / ${name} names every tab in full`, cut.length === 0, `cut short: ${cut.join(', ')}`);
    }

    const fault = columnFault(await contentColumn(page), COLUMN_CAPS);
    check(`${tag} / ${name} content column`, fault === '', fault);

    const small = await smallTargets(page);
    if (small.length) console.log(`         under 44px: ${small.join(', ').slice(0, 110)}`);

    await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`), fullPage: true });

    if (await scrollToBottom(page)) {
      await page.waitForTimeout(250);
      /*
       * THE BOTTOM MAY BE ALL RECORD. A class page's tab switch, or a handed-in
       * assignment's Take back, sits at the top; scrolled to the end there is
       * only what the student did. The top view has already been required to
       * have controls of its own, so this view is checked for what it does
       * show and not failed for having none — while a read-only screen is
       * still failed for growing one.
       */
      const below = await layoutFaults(page, readOnly ? true : 'either');
      fixedFormatSeen += below.fixedFormat;
      controlsSeen += below.controls;
      check(
        `${tag} / ${name} scrolled to the end`,
        below.faults.length === 0,
        below.faults.join('; ').slice(0, 200),
      );
    }
    counter.seen += 1;
  };
}

// ---- the tours -------------------------------------------------------------

/**
 * The screens a tab lands on directly. These are never pushed, so they have no
 * Back and must not be asked for one — the bar, or the rail, is their exit.
 */
const TAB_ROOTS = new Set([
  'home',
  'cohorts',
  'my-courses',
  'people',
  'staff',
  'staff-disabled',
  'staff-deleted',
  'staff-delete-confirm',
  'students-disabled',
  'students-deleted',
  'library',
  'library-filtered',
  'my-classes',
  'my-classes-finished',
  // Reached by opening a recording and leaving it — which lands back on a tab
  // root, with the now-playing bar on it.
  'miniplayer',
]);

/**
 * The screens that stand in place of the whole app until something is done:
 * no Back, no bar, and Sign out as the way out.
 */
const GATE_SCREENS = new Set(['rules']);

/*
 * SCREENS WITH NO CONTROL OF THEIR OWN, and it is a short list on purpose.
 *
 * The audit log, the token sheet and a student's class record are read-only:
 * cards and rows a person looks at. The starvation guard would otherwise report
 * every one of them as inert, which is true and useless — so they are declared,
 * and the declaration is checked in both directions. Everything else in the app
 * has something to press, and a screen that stops having one is news.
 */
const READ_ONLY_SCREENS = new Set([
  'audit',
  'audit-scoped',
  'my-audit',
  'tokens',
  // Returned work is the record: the grade, the feedback, what was handed in.
  // Nothing on it is the student's to change.
  'work-returned',
  // An admin who manages no class has no switches — the one staff message goes
  // to a course's managers, so the screen names who gets it instead of offering
  // a control that could do nothing. A MANAGER's `notifications` is deliberately
  // NOT here: it has the switch, and the guard runs in both directions, so the
  // day an admin's screen grows a control the declaration fails.
  'notifications-none',
]);

const STAFF_SCREENS = 58;

async function tourStaff(page, tag) {
  const counter = { seen: 0 };
  // The first tab, which for staff is the work queue.
  const visit = visitor(page, tag, 'tab-today', counter);
  const openCourse = async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Autumn 2026'));
    await tap(byId(page, 'course-open-Hikam Foundations'));
  };
  const openSession = async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, `session-open-${missed.title}`));
  };
  const more = async (option) => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, option));
  };

  // The work queue: attendance not taken, drafts waiting, deadlines closing.
  // It is the landing screen, so it is also what `home` means for staff — and
  // its failure modes ("Could not read your courses", "Checking your courses…")
  // are well-formed layouts that pass every geometric check, so it needs the
  // anchor more than any screen the tour pushes to.
  await visit('home', async () => {}, `today-att-${blocking.id}`);
  await visit('people', () => tap(byId(page, 'tab-people')), 'students-add');
  // The staff half of the People tab. A SEGMENT, not a route: same screen, other
  // list, so it is toured as its own screen and asks for no Back.
  await visit('staff', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'segment-staff'));
  }, 'staff-actions-manager@oursabeel.com');
  // A colleague's menu, OPEN: the role and access choices exist in no other
  // state.
  await visit('staff-actions', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'segment-staff'));
    await tap(byId(page, 'staff-actions-manager@oursabeel.com'));
  }, 'staff-role-manager@oursabeel.com');
  // The staff list's disabled section EXPANDED — the same closed section the
  // student list has.
  await visit('staff-disabled', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'segment-staff'));
    await tap(byId(page, 'staff-disabled'));
  }, 'staff-actions-yusuf.rahman@oursabeel.com');
  // Delete, asked again on a disabled colleague's row: the warning takes the
  // row's place, and exists in no other state.
  await visit('staff-delete-confirm', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'segment-staff'));
    await tap(byId(page, 'staff-disabled'));
    await tap(byId(page, 'staff-actions-yusuf.rahman@oursabeel.com'));
    await tap(byId(page, 'staff-delete-sw-disabled'));
  }, 'staff-delete-confirm-sw-disabled');
  // The deleted colleagues EXPANDED: names alone, with no menu.
  await visit('staff-deleted', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'segment-staff'));
    await tap(byId(page, 'staff-deleted'));
  }, 'staff-deleted-sw-deleted');
  // The create sheet OPEN — a form that exists in no other state, and the one
  // affordance that is absent entirely on a native build.
  await visit('students-add', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'students-add'));
  }, 'student-create');
  // The disabled section EXPANDED: rows that exist in no other state, and the
  // collapsible's own header row moves when they arrive.
  await visit('students-disabled', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'students-disabled'));
    // A ROW inside the section, not the section's own header: the collapsible's
    // Pressable renders open or closed, so anchoring on it asserts nothing.
  }, `student-open-${DISABLED_STUDENT.email}`);
  // The deleted students EXPANDED, and one's page: a name with no address
  // under it, and a menu that holds their record and nothing else.
  await visit('students-deleted', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'students-deleted'));
  }, `student-open-${DELETED_STUDENT.uid}`);
  await visit('student-deleted', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'students-deleted'));
    await tap(byId(page, `student-open-${DELETED_STUDENT.uid}`));
  }, 'student-actions');
  // Delete, asked again, on a disabled student's page.
  await visit('student-delete-confirm', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, 'students-disabled'));
    await tap(byId(page, `student-open-${DISABLED_STUDENT.email}`));
    await tap(byId(page, 'student-actions'));
    await tap(byId(page, 'student-delete'));
  }, 'student-delete-confirm');
  // Anchored on the LAST seeded history row, not on the Access card: the
  // history is a second listener, and a page measured before it answered is a
  // page measured without the six rows at the bottom of it.
  await visit('student', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, `student-open-${STUDENT.email}`));
  }, `student-history-${HISTORY_ROW}`);
  // The student's menu, OPEN, an admin's: all three choices.
  await visit('student-actions', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, `student-open-${STUDENT.email}`));
    await tap(byId(page, 'student-actions'));
  }, 'student-access');
  await visit('cohorts', () => tap(byId(page, 'tab-courses')), 'cohorts-add');
  /*
   * THE CREATE SHEETS, OPEN — these three, and `students-add` above.
   *
   * A sheet is a screen this app has and no tour was entering: its form exists
   * in no other state, it is the narrowest column in the product (a modal panel
   * inside a 320px viewport), and the sessions one carries two `DateField`s,
   * which are the app's only fixed-format controls. Photographed closed, all of
   * that was measured at zero widths.
   */
  await visit('cohorts-add', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohorts-add'));
  }, 'cohort-create');
  await visit('cohort', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Autumn 2026'));
  }, 'courses-add');
  // The empty state. No amount of seeding shows it, and it is the screen a term
  // spends its first week in.
  await visit('cohort-empty', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Spring 2027 — Evening Intensive'));
  }, 'courses-add');
  await visit('courses-add', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Autumn 2026'));
    await tap(byId(page, 'courses-add'));
  }, 'course-create');
  // The rename sheets, OPEN: the name field and Save live nowhere else.
  await visit('cohort-rename', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Autumn 2026'));
    await tap(byId(page, 'cohort-rename-open'));
  }, 'cohort-rename-save');
  await visit('course', openCourse, 'nav-sessions');
  await visit('course-rename', async () => {
    await openCourse();
    await tap(byId(page, 'course-rename-open'));
  }, 'course-rename-save');
  // The roster's picker, OPEN: the students who can be added, each a row — on
  // the long-named course, whose roster leaves some out.
  await visit('course-add-student', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohort-open-Autumn 2026'));
    await tap(byId(page, `course-open-${LONG_COURSE_NAME}`));
    await tap(byId(page, 'roster-add'));
  }, `enrol-${UNENROLLED.email}`);
  // A roster removal CONFIRMS IN PLACE — the row is replaced by a warning and
  // two buttons, which is more than fits where the row was.
  await visit('course-remove-confirm', async () => {
    await openCourse();
    await tap(byId(page, `roster-remove-${STUDENT.email}`));
  }, `roster-remove-confirm-${STUDENT.email}`);
  /*
   * ANCHORED ON A ROW, NOT ON THE CHROME.
   *
   * The Export button renders — disabled — beside "No sessions in this course
   * yet", so anchoring on it measured whichever state the screen happened to be
   * in and would have reported the two widest grids in the app as sound while
   * showing nothing at all. A row can only be there if the data arrived, which
   * is what this screen is for. (The segment cannot serve: `Segmented` renders
   * every option's testID whichever is selected, so it cannot say which view is
   * on screen — hence a row of THIS view.)
   */
  await visit('course-attendance', async () => {
    await openCourse();
    await tap(byId(page, 'nav-attendance'));
  }, `attendance-session-${missed.title}`);
  // The per-student tab: the widest grid in the app, and the other half of the
  // screen above.
  await visit('course-attendance-students', async () => {
    await openCourse();
    await tap(byId(page, 'nav-attendance'));
    await tap(byId(page, 'attendance-tab-students'));
  }, `attendance-student-${STUDENT.name}`);
  await visit('sessions', async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
  }, 'sessions-add');
  await visit('sessions-add', async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, 'sessions-add'));
  }, 'session-create');
  await visit('session', openSession, 'recording-ledger');
  // The recording's menus, OPEN: what takes it away, and where files come from.
  await visit('recording-actions', async () => {
    await openSession();
    await tap(byId(page, 'recording-actions'));
  }, 'recording-archived');
  await visit('recording-add', async () => {
    await openSession();
    await tap(byId(page, 'recording-add'));
  }, 'recording-import-zoom-more');
  // The session editor: four fields and a Save/Cancel row that exist nowhere
  // else, and 320px is where they run out of room.
  // A recording of several files: parts, versions, a failed copy, the
  // default-version choice — the media list's every row kind, and only here.
  await visit('session-media', async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, 'session-open-Session 8 — The Signs of Sincerity'));
  }, 'recording-media');
  check(
    `${tag} / the media list shows each part with its files, and says why the failed one failed`,
    (await page.locator('[data-testid^="media-part-"]').count()) === 2 &&
      (await page.locator('[data-testid^="media-item-"]').count()) === 3 &&
      (await byId(page, 'media-item-p2a').innerText().catch(() => '')).includes('HTTP 404') &&
      (await byId(page, 'recording-retry-import').count()) === 1 &&
      (await page.locator('[data-testid^="media-default-"]').count()) === 2,
  );
  await visit('session-editing', async () => {
    await openSession();
    await tap(byName(page, 'Edit session'));
  }, 'session-save');
  await visit('recording-ledger', async () => {
    await openSession();
    await tap(byId(page, 'recording-ledger'));
  }, 'ledger-filter-all');
  // The override editor, open: a reason field and two more buttons inside a row
  // that already carries a name and a status.
  await visit('ledger-override', async () => {
    await openSession();
    await tap(byId(page, 'recording-ledger'));
    await tap(byId(page, `override-open-${STUDENT.name}`));
  }, `override-reason-${STUDENT.name}`);
  await visit('student-ledger', async () => {
    await openCourse();
    await tap(byId(page, `student-ledger-${STUDENT.email}`));
  }, 'student-ledger-profile');
  // Assignments: the course's list, a new one's form, one assignment's page
  // and its edit form, grading one student's work, and one student's
  // assignments in the course.
  const openCoursework = async () => {
    await openCourse();
    await tap(byId(page, 'nav-coursework'));
  };
  const openMemorize = async () => {
    await openCoursework();
    await tap(byId(page, 'coursework-Memorize the first hikma'));
  };
  await visit('coursework-list', openCoursework, 'coursework-new');
  await visit('coursework-new', async () => {
    await openCoursework();
    await tap(byId(page, 'coursework-new'));
  }, 'coursework-audience');
  await visit('coursework-detail', openMemorize, 'coursework-return-graded');
  await visit('coursework-edit', async () => {
    await openMemorize();
    await tap(byId(page, 'coursework-edit'));
  }, 'coursework-save');
  await visit('grade', async () => {
    await openMemorize();
    await tap(byId(page, `work-row-${TO_GRADE.name}`));
  }, 'grade-feedback');
  await visit('student-assignments', async () => {
    await openCourse();
    await tap(byId(page, `student-ledger-${STUDENT.email}`));
    await tap(byId(page, 'student-tab-assignments'));
  }, 'student-work-Memorize the first hikma');
  // The ledger of a recording on a course ARCHIVED WITH LISTENING OFF: the one
  // row state — "Closed (course archived)" — that no live course can show, on
  // a recording that is still published and inside its date. Reached through
  // the archived cohort's collapsed section, which is the only way there.
  await visit('recording-ledger-archived', async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'cohorts-archived'));
    await tap(byId(page, 'cohort-open-Spring 2026'));
    await tap(byId(page, 'course-open-Seerah Survey'));
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, `session-open-${archived.title}`));
    await tap(byId(page, 'recording-ledger'));
  }, `ledger-row-${STUDENT.name}`);
  check(`${tag} an open grant on an archived class reads as closed, not as still to do`,
    /Closed \(course archived\)/.test(await byId(page, `ledger-row-${STUDENT.name}`).innerText().catch(() => '')));
  /*
   * THE PICKER'S ROWS, FROM A ZOOM THAT ANSWERS AT THE BROWSER.
   *
   * The emulator suite has no Zoom credentials, so the real callable throws and
   * the rows — where this screen's layout actually breaks — would be laid out
   * at no width at all. The callable's reply is served here instead, in the
   * shape `ZoomMeetingRow` declares; what it skips is the Zoom client, which
   * `functions/test/unit/zoomRange.test.ts` drives against a fake `fetch`.
   *
   * The rows are the case the picker exists to settle: one recurring meeting,
   * so one topic on every card, and a class at 7:30 pm Houston time whose
   * UTC stamp is the NEXT day. The anchor is that evening row — it appears
   * under the session's date, with the same-day filter on by default, only if
   * the picker dates rows by the institute's calendar.
   */
  await page.route('**/listZoomRecordings', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ result: zoomRows() }) });
  });
  const openZoomImport = async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, 'session-open-Session 6 — Today (recording pending)'));
    await tap(byId(page, 'recording-import-zoom'));
  };
  await visit('zoom-import', openZoomImport, 'zoom-when-zoom-evening');
  check(
    `${tag} / zoom import opens on the session's date: its two classes, nothing from other days`,
    (await page.locator('[data-testid^="zoom-when-"]').count()) === 2 &&
      (await page.locator('[data-testid^="zoom-open-"]').count()) === 0,
  );
  const evening = (await byId(page, 'zoom-when-zoom-evening').innerText().catch(() => '')).replace(/\u2011/g, '-');
  check(
    `${tag} / zoom import dates an evening class by Houston's calendar and shows its hours`,
    new RegExp(`^${PENDING_DATE} · \\d{1,2}:\\d{2}–\\d{1,2}:\\d{2} PM$`).test(evening),
    JSON.stringify(evening),
  );
  // Files CHOSEN: the running total and the Import button's count exist in no
  // other state, and the total is the longest line the screen carries.
  // Files chosen for upload, before any is sent: the placement chips exist
  // only in this state. A video that may be Part 1's version, and a file the
  // app does not take, which says so in its row.
  await visit('upload-chosen', async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, 'session-open-Session 8 — The Signs of Sincerity'));
    await tap(byId(page, 'recording-add'));
    const chooser = page.waitForEvent('filechooser');
    await tap(byId(page, 'recording-upload'));
    await (await chooser).setFiles([
      { name: 'Whiteboard, second half of the class.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048) },
      { name: 'Handout.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(16) },
    ]);
  }, 'upload-panel');
  check(
    `${tag} / a chosen file can be a new part or Part 1's video, and a file the app does not take says so`,
    (await byId(page, 'upload-place-0-part').count()) === 1 &&
      (await byId(page, 'upload-place-0-v1').count()) === 1 &&
      (await byId(page, 'upload-row-1').innerText().catch(() => '')).includes('M4A, MP3, WAV or MP4') &&
      (await byId(page, 'upload-start').innerText().catch(() => '')).includes('Upload 1 file'),
  );
  await tap(byId(page, 'upload-dismiss'));

  await visit('zoom-import-chosen', async () => {
    await openZoomImport();
    await tap(byId(page, 'zoom-pick-videoAndAudio-zoom-day'));
  }, 'zoom-selected');
  const total = await byId(page, 'zoom-selected').innerText().catch(() => '');
  check(
    `${tag} / a quick pick chooses the stretch of class, not the short restart or the file still processing`,
    /^Selected: 2 files · .* · 1 h 5 min of class · /.test(total) &&
      (await byId(page, 'zoom-file-day-spk').getAttribute('aria-checked')) === 'true' &&
      // react-native-web leaves `aria-checked` off a box that is not ticked.
      (await byId(page, 'zoom-file-day2-aud').getAttribute('aria-checked')) !== 'true' &&
      (await byId(page, 'zoom-file-day3-aud').getAttribute('aria-disabled')) === 'true',
    JSON.stringify({
      total,
      spk: await byId(page, 'zoom-file-day-spk').getAttribute('aria-checked'),
      short: await byId(page, 'zoom-file-day2-aud').getAttribute('aria-checked'),
      processing: await byId(page, 'zoom-file-day3-aud').getAttribute('aria-disabled'),
    }),
  );
  // Every date, every status: the "already imported" row — the longest line a
  // card carries, naming the class it went into — exists in no other state.
  // The picker's filters, OPEN.
  await visit('zoom-filters', async () => {
    await openZoomImport();
    await tap(byId(page, 'zoom-filters'));
  }, 'zoom-filter-all');
  await visit('zoom-import-all', async () => {
    await openZoomImport();
    await tap(byId(page, 'zoom-session-day'));
    await tap(byId(page, 'zoom-filters'));
    await tap(byId(page, 'zoom-filter-all'));
    await tap(byName(page, 'Close'));
  }, 'zoom-open-earlier-aud');
  check(
    `${tag} / zoom import with the date filter off shows the other days too`,
    (await page.locator('[data-testid^="zoom-when-"]').count()) === 3 &&
      (await page.locator('[data-testid^="zoom-open-"]').count()) === 1,
  );
  await visit('library', () => tap(byId(page, 'tab-library')), 'library-status');
  // With a cohort CHOSEN: the clear control exists in no other state, and two
  // dropdowns plus a button is the row that has to wrap at 320px.
  await visit('library-filtered', async () => {
    await tap(byId(page, 'tab-library'));
    await byId(page, 'library-cohort').selectOption({ index: 1 });
  }, 'library-clear');
  await visit('player', async () => {
    await tap(byId(page, 'tab-library'));
    await tap(byId(page, `library-play-${missed.title}`));
  }, 'player-scrubber');
  // The overflow sheet ITSELF, open. It is the one wholly new component of the
  // nav shell, it is a modal panel inside a 320px viewport, and the tours all
  // passed straight through it to an option — so nothing had ever measured it.
  await visit('more', () => tap(byId(page, 'tab-more')), 'more-privacy');
  // Help: the list, and a film open — its player exists in no other state.
  await visit('help', () => more('more-help'), 'help-film-staff-today');
  await visit('help-film', async () => {
    await more('more-help');
    await tap(byId(page, 'help-film-staff-today'));
  }, 'help-film');
  // Report a problem: the field and Send, the same screen for both populations.
  await visit('report', () => more('more-report'), 'report-text');
  await visit('audit', () => more('more-audit'), 'audit-list');
  /*
   * AN ADMIN'S NOTIFICATIONS SCREEN HAS NO SWITCHES.
   *
   * The one staff message — "attendance still not taken" — is sent to a course's
   * `managerUids`, and an admin who manages no class is in none of them, so the
   * screen states that instead of offering a control that could do nothing. That
   * sentence is a paragraph rather than a row, and 320px is where a paragraph in
   * a card runs out of room, so it is toured as its own screen. The switch row
   * itself is measured on the manager's tour, where it renders.
   */
  await visit('notifications-none', () => more('more-notifications'), 'notify-none');
  await checkDeviceState(page, tag);
  await visit('tokens', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byName(page, 'Design tokens'));
  }, 'tokens-sheet');

  check(`${tag} toured as many staff screens as the tour lists`, counter.seen === STAFF_SCREENS,
    `${counter.seen}/${STAFF_SCREENS}`);
}

const MANAGER_SCREENS = 12;

/**
 * A manager sees the same screens with fewer rows AND fewer controls, which is a
 * different layout rather than the same one with less in it: no Cohorts, no
 * Staff, a home with a different set of buttons, a course whose admin-only
 * actions are simply absent, an audit scoped to their own class.
 *
 * Toured separately because an admin's run is not evidence about it. A row that
 * fits once its Disable button is gone proves nothing about the row that still
 * has one, and the reverse — a manager's narrower row breaking where the
 * admin's wraps — is the case nobody would ever see, because the person who
 * owns the app never renders it.
 */
async function tourManager(page, tag) {
  const counter = { seen: 0 };
  const visit = visitor(page, tag, 'tab-today', counter);
  // A manager's Courses tab lands on their own courses — the rules give them no
  // cohort list at all, so the same tab resolves to a different screen.
  const openCourse = async () => {
    await tap(byId(page, 'tab-courses'));
    await tap(byId(page, 'course-open-Hikam Foundations'));
  };

  await visit('home', async () => {}, `today-att-${blocking.id}`);
  // Grading reaches a teacher through Today: the classmates' hand-ins on the
  // course they manage by name, last on the screen.
  check(`${tag} home lists the assignment to grade`,
    await byId(page, 'today-grade-sw-cw1').isVisible().catch(() => false));
  await visit('my-courses', () => tap(byId(page, 'tab-courses')), 'course-open-Hikam Foundations');
  await visit('coursework-detail', async () => {
    await openCourse();
    await tap(byId(page, 'nav-coursework'));
    await tap(byId(page, 'coursework-Memorize the first hikma'));
  }, 'coursework-edit');
  await visit('course', openCourse, 'nav-sessions');
  await visit('audit-scoped', async () => {
    await openCourse();
    await tap(byId(page, 'nav-audit'));
  }, 'audit-list');
  // A manager's OWN actions, which the class-scoped view above cannot contain:
  // creating a student without naming a course produces an entry belonging to no
  // class. Only a manager has this screen — an admin's institute-wide view is
  // already a superset — so an admin's run is no evidence about it.
  await visit('my-audit', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-my-audit'));
  }, 'my-audit-list');
  await visit('library', () => tap(byId(page, 'tab-library')), 'library-status');
  // People, and one student's page. A manager's People tab is not an admin's
  // with rows removed: the student page swaps a whole query for a per-course
  // one, drops the Disable control for a sentence explaining who has it, and
  // shows "Courses you manage" where an admin sees every enrolment. None of
  // that renders in an admin's run, so none of it was ever photographed.
  await visit('people', () => tap(byId(page, 'tab-people')), 'students-add');
  // Anchored on a history row in THEIR course: a manager's history is read
  // through the `in`-pinned arm of the audit rule, which is the one that can
  // fail closed — and a denial there is an empty card, not an error.
  await visit('student', async () => {
    await tap(byId(page, 'tab-people'));
    await tap(byId(page, `student-open-${STUDENT.email}`));
  }, `student-history-${HISTORY_ROW_MANAGED}`);
  // The ledger, which a manager reads through a DIFFERENT rule arm than an
  // admin: theirs resolves a course lookup from the row, so it is the only one
  // that can fail closed — and it did, silently, as an empty roster. A denial
  // renders as no rows at all, which is why this belongs in a sweep that
  // asserts what is on screen and not only that a screenshot was taken.
  const openSession = async () => {
    await openCourse();
    await tap(byId(page, 'nav-sessions'));
    await tap(byId(page, `session-open-${missed.title}`));
  };
  await visit('recording-ledger', async () => {
    await openSession();
    await tap(byId(page, 'recording-ledger'));
  }, 'ledger-filter-all');
  await visit('ledger-override', async () => {
    await openSession();
    await tap(byId(page, 'recording-ledger'));
    await tap(byId(page, `override-open-${STUDENT.name}`));
  }, `override-reason-${STUDENT.name}`);
  // The staff switch row, which only a manager has — see the note on the admin's
  // notifications visit above.
  await visit('notifications', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-notifications'));
  }, 'notify-attendanceMissing');
  await checkDeviceState(page, tag);

  check(`${tag} toured as many manager screens as the tour lists`, counter.seen === MANAGER_SCREENS,
    `${counter.seen}/${MANAGER_SCREENS}`);
}

const STUDENT_SCREENS = 16;

async function tourStudent(page, tag) {
  const counter = { seen: 0 };
  const visit = visitor(page, tag, 'tab-todo', counter);

  // To do, with all six groups on it — Past due, Due soon, Upcoming, Missed,
  // Archived, Done — and both kinds of work in them. Those group headings ARE
  // the layout, and the anchor alone says only that the hero arrived: a group
  // whose seed stopped producing it would leave the screen untested with every
  // geometric check green.
  await visit('home', async () => {}, `next-up-${dueSoon.title}`);
  for (const group of ['pastDue', 'dueSoon', 'upcoming', 'missed', 'archived', 'done']) {
    check(`${tag} home lists the ${group} group`,
      await byId(page, `group-${group}`).isVisible().catch(() => false));
  }
  await visit('my-classes', () => tap(byId(page, 'tab-classes')), 'myclass-Hikam Foundations');
  // The closed Finished section, opened: the classes in it exist in no other
  // state, so they are toured as a screen of their own.
  await visit(
    'my-classes-finished',
    async () => {
      await tap(byId(page, 'tab-classes'));
      await tap(byId(page, 'classes-finished'));
    },
    'myclass-Seerah Survey',
  );
  await visit('class-record', async () => {
    await tap(byId(page, 'tab-classes'));
    await tap(byId(page, 'myclass-Hikam Foundations'));
  }, `attendance-${missed.title}`);
  // The record of a class archived with listening off: the one row whose
  // listening line can say "course archived". Not a `visit` — the page has no
  // control of its own to measure, and the sweep refuses a screen where its
  // geometric checks would be inert. A wording check, on the way past.
  await tap(byId(page, 'tab-classes'));
  // A finished class waits in the closed Finished section; opening it is part
  // of the way there.
  await tap(byId(page, 'classes-finished'));
  await tap(byId(page, 'myclass-Seerah Survey'));
  // The row arrives with the marks and its listening line with the grants, a
  // second listener — so wait for the words, not the row.
  const archivedRow = byId(page, `attendance-${archived.title}`);
  const closedLine = await archivedRow
    .filter({ hasText: 'course archived' })
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  check(`${tag} an archived class's record says the recording is closed, not still to listen to`, closedLine);
  // An open recording: the transport, the scrubber and the speed chips, which
  // are the only fixed-width row in the app.
  // The home screen promotes the most urgent OPEN recording to a hero card and
  // drops it from the grouped list below, so this is where that one is.
  const openDueSoon = () => tap(byId(page, `next-up-${dueSoon.title}`));
  await visit('player', openDueSoon, 'player-scrubber');
  // THE DOCKED NOW-PLAYING BAR, on a screen that is not the player. It is a row
  // that exists in no other state and it eats 56px off the bottom of every
  // screen under it — which on a 320px phone is exactly where a list runs out
  // of room. Reached by opening a recording and then leaving, because that is
  // the only way it appears.
  await visit('miniplayer', async () => {
    await openDueSoon();
    await page.waitForTimeout(1500);
    await tap(byId(page, 'tab-classes'));
    // The anchor is what asserts it. Without it this "screen" is byte-identical
    // to `my-classes` if the bar stops rendering, every geometric check passes,
    // and the tour still reports having toured it.
  }, 'mini-player');
  // An assignment in each state its screen has: open with a draft saved,
  // past due (the late-work sentence), handed in (Take back), and returned
  // (the grade). Reached from To do, as a student reaches them.
  const openWork = (title) => tap(byId(page, `task-${title}`));
  await visit('work-to-do', () => openWork('Memorize the first hikma'), 'work-hand-in');
  await visit('work-past-due', () => openWork('Letter forms, week 3'), 'work-hand-in');
  await visit('work-handed-in', () => openWork('Joining letters worksheet'), 'work-take-back');
  await visit('work-returned', () => openWork('Reflection on the first hikma'), 'work-returned');
  // The class page's other tab: the whole term's assignments, each opening.
  await visit('class-assignments', async () => {
    await tap(byId(page, 'tab-classes'));
    await tap(byId(page, 'myclass-Hikam Foundations'));
    await tap(byId(page, 'class-tab-assignments'));
  }, 'class-work-Memorize the first hikma');
  // A student's More is a different sheet: no audit row, and a password reset
  // staff do not get.
  await visit('more', () => tap(byId(page, 'tab-more')), 'more-password');
  await visit('report', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-report'));
  }, 'report-text');
  await visit('notifications', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-notifications'));
  }, 'notify-recordingReady');
  await checkDeviceState(page, tag);
  await visit('help', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-help'));
  }, 'help-film-student-to-do');
  await visit('help-film', async () => {
    await tap(byId(page, 'tab-more'));
    await tap(byId(page, 'more-help'));
    await tap(byId(page, 'help-film-student-to-do'));
  }, 'help-film');

  /*
   * NOT toured: the player with access closed. A missed card is deliberately
   * not a button — the server would refuse to mint a URL, and a card that looks
   * tappable and then refuses reads as a broken app rather than a deadline that
   * passed — so no route a student has reaches that layout. The missed CARD is
   * on `home` and the closed line is on `class-record`, which is the whole of
   * what a student is actually shown about it. Give a student a way to open a
   * closed recording and this is where its width sweep belongs.
   */

  check(`${tag} toured as many student screens as the tour lists`, counter.seen === STUDENT_SCREENS,
    `${counter.seen}/${STUDENT_SCREENS}`);
}

const RULES_SCREENS = 1;

/**
 * THE INSTITUTE'S RULES, as an account that has not accepted them meets them:
 * a gate in place of the whole app. Its home marker is the rules' own text,
 * which `goHome` may click harmlessly; "I agree" is never pressed, so every
 * width meets the same screen.
 */
async function tourRules(page, tag) {
  const counter = { seen: 0 };
  const visit = visitor(page, tag, 'rules-text', counter);
  await visit('rules', async () => {}, 'rules-agree');
  check(`${tag} the rules stand in place of the app: no bar, no rail`, !(await byId(page, 'tab-more').isVisible().catch(() => false)));
  check(`${tag} toured as many rules screens as the tour lists`, counter.seen === RULES_SCREENS, `${counter.seen}/${RULES_SCREENS}`);
}

// ---- the sweep -------------------------------------------------------------

async function signInStaff(page, testId, homeMarker) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await tap(byId(page, testId), 60_000);
  await byId(page, homeMarker).waitFor({ timeout: 60_000 });
}

async function signInRulesUnseen(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await byId(page, 'signin-email').fill(RULES_UNSEEN.email);
  await byId(page, 'signin-password').fill(STUDENT_PASSWORD);
  await tap(byId(page, 'signin-student'));
  await byId(page, 'rules-agree').waitFor({ timeout: 60_000 });
}

async function signInStudent(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await byId(page, 'signin-email').fill(STUDENT.email);
  await byId(page, 'signin-password').fill(STUDENT_PASSWORD);
  await tap(byId(page, 'signin-student'));
  await byId(page, 'tab-todo').waitFor({ timeout: 60_000 });
}

const TOURS = [
  ['staff', (page) => signInStaff(page, 'dev-signin-first-admin', 'tab-today'), tourStaff],
  ['manager', (page) => signInStaff(page, 'dev-signin-manager', 'tab-today'), tourManager],
  ['student', signInStudent, tourStudent],
  ['rules', signInRulesUnseen, tourRules],
];

try {
  const runs = [
    ...WIDTHS.map((w) => [`${w}px`, { viewport: { width: w, height: 900 } }, w]),
    ...PROFILES.map(([label, d]) => [label, d, d.viewport.width]),
  ];
  for (const [tag, contextOptions, width] of runs) {
    for (const [who, signIn, tour] of TOURS) {
      // A fresh context per population: sessions do not share, and a stale one
      // restores the OTHER population's route — the shared-device case the route
      // tables were split for.
      const ctx = await browser.newContext(contextOptions);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(`${tag}/${who} page error`, false, String(e).slice(0, 110)));
      await signIn(page);
      // Before the tour, so a viewport that did not apply fails here rather than
      // a whole tour later, having quietly measured the wrong width.
      const at = await laidOutAt(page);
      check(
        `${tag}/${who} laid out at ${width}px`,
        at.layout === width,
        `documentElement.clientWidth = ${at.layout}, window.innerWidth = ${at.window}`,
      );
      await tour(page, `${tag}-${who}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

// The app puts a `DateField` on three toured screens — the session EDITOR (the
// read-only session screen has none), the `sessions-add` sheet, and ZoomImport —
// so this is a real expectation rather than a formality.
/*
 * `> 0`, not a threshold. The honest claim without a run is "it looked at
 * something"; anything larger would be a number reasoned to rather than
 * measured, which is the thing this file exists to distrust — and it would be a
 * fabricated figure inside the fix for a fabricated-safety bug. The real counts
 * are printed instead, so a fall from many to few is visible to a reader
 * without a threshold pretending to be data.
 */
check(
  'the squash check examined some fixed-format controls',
  fixedFormatSeen > 0,
  'its selector matched nothing all sweep — the check is inert, not passing',
);
console.log(`examined: ${controlsSeen} controls, ${fixedFormatSeen} fixed-format`);

const failed = results.filter((r) => !r.ok);
const viewports = WIDTHS.length + PROFILES.length;
const screens = STAFF_SCREENS + MANAGER_SCREENS + STUDENT_SCREENS + RULES_SCREENS;
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`shots/screens/ — ${viewports} viewports x ${screens} screens`);
if (!FULL) console.log('SWEEP_FULL=1 adds real device profiles (DPR, touch, UA).');
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
