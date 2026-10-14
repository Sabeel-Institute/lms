/**
 * Capture user-manual screenshots from the WEB app — every screen at phone
 * (390) and desktop (1280) width. Against the emulator with the guide dataset
 * (scripts/seed-guide.mjs). Home is a goto of `/`, which is the Home path — the
 * stack is browser history now, so goBack() would work too.
 *
 * Model: Cohort → Course → Session → Recording. Recordings and attendance live
 * on a session; being marked EXCUSED is what opens a recording to a student and
 * requires them to play it, until the session's due date.
 */
import { chromium } from 'playwright';
import { WEB_PORTS } from './lib/ports.mjs';

const WEB = `http://127.0.0.1:${WEB_PORTS.e2e}/`;
const DIR = 'docs/manual/img';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const browser = await chromium.launch();

async function newPage(vp) {
  // REDUCED MOTION, so a figure is the screen at rest: the player's long title
  // slides along its line, and a capture caught it mid-slide ("ssion 3 — …").
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(WEB, { waitUntil: 'networkidle' });
  return p;
}
const tap = (p, id) => p.getByTestId(id).click();
const home = async (p) => { await p.goto(WEB, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500); };

/**
 * How far down to cut a capture, when something below that point must not ship.
 *
 * The sign-in screen carries the emulator dev-sign-in panel ("as faisal.shah
 * (first admin)", "as manager", "as outsider (refused)"), because these
 * shots are taken against a DEV server — that panel is what every suite here
 * uses to reach an authenticated screen at all. It is also the first figure in
 * a manual written for institute staff, so it cannot appear in it. Cutting
 * above the panel is honest: everything the reader is shown is real, there is
 * simply less of it.
 *
 * FAILS CLOSED. Returning null when the anchor is missing let `pair` fall
 * through to a full-height capture, which is the one outcome this function
 * exists to prevent — a redaction that quietly does nothing is worse than none.
 */
async function heightAbove(p, testId) {
  const box = await p.getByTestId(testId).boundingBox().catch(() => null);
  if (!box) throw new Error(`heightAbove: no "${testId}" to cut above — refusing to ship the full page`);
  // Back up past the panel's own dashed border and the gap above it.
  return Math.max(200, Math.round(box.y - 40));
}

/**
 * How tall the viewport must be to show the whole screen.
 *
 * `fullPage: true` IS A NO-OP HERE, and that is not obvious. It grows the
 * capture to the DOCUMENT height, and react-native-web pins its root to the
 * viewport — the page never scrolls, an inner ScrollView does. So every figure
 * was silently the top 900px of its screen, which sliced "Submit attendance" in
 * half in the session figure. Measuring the scroller and growing the viewport to
 * it is what actually captures the screen.
 */
async function contentHeight(p, fallback) {
  // FAILS CLOSED, like `heightAbove`. Returning the viewport height when the
  // measurement fails reproduces the exact bug this function was written for —
  // every figure silently the top 900px of its screen — with nothing to show
  // for it.
  const h = await p.evaluate(() => {
    /*
     * THE SCROLL CONTAINERS, WHETHER OR NOT THEY CURRENTLY OVERFLOW — and the
     * distinction is the whole point.
     *
     * Every screen in this app renders inside a `Screen`, whose ScrollView is a
     * scroll container at every width. So NONE at all means the page did not
     * render, which is the failure this function exists to catch; asking only
     * for containers that are currently overflowing cannot tell that apart from
     * a short screen that simply fits, and -1 was unreachable.
     */
    const boxes = [...document.querySelectorAll('div')].filter((el) =>
      /auto|scroll/.test(getComputedStyle(el).overflowY),
    );
    if (!boxes.length) return -1;
    const over = boxes.filter((el) => el.scrollHeight > el.clientHeight);
    // A rendered screen with nothing to scroll: it fits, and the caller's
    // viewport height is the right answer rather than a guess.
    if (!over.length) return 0;
    over.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
    const el = over[0];
    // The chrome outside the scroller — header, tab bar, now-playing strip.
    return Math.ceil(el.scrollHeight + (window.innerHeight - el.clientHeight));
  });
  if (h < 0) throw new Error('contentHeight: the page rendered no screen — refusing to guess a height');
  // Capped: a fourteen-student roster at full length is a figure nobody reads,
  // and a 6000px PNG in a PDF is worse than a scrolled one.
  return Math.min(Math.max(h, fallback), 2400);
}

/**
 * `prepare` runs again at EACH size, before that size's capture, so a figure of
 * a transient state — an open editor, an expanded section — is set up for both
 * shots rather than captured once and resized around.
 *
 * It runs again; it does not START again. A state opened for the phone shot
 * SURVIVES the resize, so a `prepare` that acts unconditionally opens a second
 * one at desktop width — which is why the only one in this file checks first.
 */
async function pair(p, name, { cutAbove = null, prepare = null } = {}) {
  for (const [size, suffix] of [[PHONE, 'phone'], [DESKTOP, 'desktop']]) {
    await p.setViewportSize(size);
    await p.waitForTimeout(size === PHONE ? 500 : 700);
    if (prepare) {
      await prepare(p);
      await p.waitForTimeout(600);
    }
    const cut = cutAbove ? await heightAbove(p, cutAbove) : null;
    const height = cut ?? (await contentHeight(p, size.height));
    await p.setViewportSize({ width: size.width, height });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${DIR}/${name}-${suffix}.png` });
  }
  await p.setViewportSize(PHONE); await p.waitForTimeout(300);
  console.log('  ✓', name);
}

/** Open one of the rows behind "More" — the audit history lives there. */
async function more(p, option) {
  await tap(p, 'tab-more'); await p.waitForTimeout(600);
  await tap(p, option);
}

// Admin: Courses → Autumn 2026 → Hikam Foundations, from home.
async function openHikam(p) {
  await home(p);
  await tap(p, 'tab-courses'); await p.waitForTimeout(2000);
  await tap(p, 'cohort-open-Autumn 2026'); await p.waitForTimeout(2000);
  await tap(p, 'course-open-Hikam Foundations');
  await p.getByTestId('nav-sessions').waitFor({ timeout: 15000 });
}

console.log('Student');
const stu = await newPage(PHONE);
await stu.getByTestId('signin-email').waitFor({ timeout: 30000 });
await pair(stu, '01-signin', { cutAbove: 'dev-signin-first-admin' });
await stu.getByTestId('signin-email').fill('fatima.ahmed@example.com');
await stu.getByTestId('signin-password').fill('HikamStudent1');
await tap(stu, 'signin-student');
await stu.getByTestId('screen-title').filter({ visible: true, hasText: /^To do$/ }).first().waitFor({ timeout: 25000 });
await pair(stu, '02-student-home');
// The hero card: the home screen promotes the most urgent recording still open
// and drops it from the grouped list, so this is the handle it has.
await tap(stu, 'next-up-Session 3 — Patience in Hardship');
await stu.getByTestId('player-play').waitFor({ timeout: 25000 });
await tap(stu, 'player-play');
await stu.waitForTimeout(2500);
await pair(stu, '03-player');

/*
 * THE DOCKED BAR, WHICH NEEDS A TAB TAP AND NOT A RELOAD.
 *
 * The manual describes it twice and no figure had ever shown it, because
 * `home()` is a `goto` — a full reload, which destroys the module-level
 * playback session the bar is a view onto. Leaving the player by tapping a tab
 * is what a listener actually does, and it is the only way the bar renders.
 */
await tap(stu, 'tab-classes');
await stu.getByTestId('mini-player').waitFor({ timeout: 20000 });
await stu.waitForTimeout(1200);
await pair(stu, '03b-mini-player');

await tap(stu, 'myclass-Hikam Foundations');
await stu.waitForTimeout(3000);
await pair(stu, '04-attendance-record');

// An assignment to do, its answer already started — and one already returned.
await home(stu);
await tap(stu, 'task-Memorize the first hikma');
await stu.getByTestId('work-note').waitFor({ timeout: 30000 });
await stu.waitForTimeout(2500);
await pair(stu, '05-work');
await home(stu);
await tap(stu, 'task-Reflection on the first hikma');
await stu.getByTestId('work-returned').waitFor({ timeout: 20000 });
await stu.waitForTimeout(1500);
await pair(stu, '06-work-returned');
await stu.context().close();

console.log('Admin / staff');
const adm = await newPage(PHONE);
// No `bootstrapAdmin`: the seed pre-provisions this account as an approved admin
// (see `seed-guide.mjs`), and the dev sign-in links to it. A bootstrap call
// would be refused anyway — an admin already exists.
await tap(adm, 'dev-signin-first-admin');
await adm.getByTestId('tab-today').waitFor({ timeout: 30000 });
await adm.waitForTimeout(2500);
await pair(adm, '10-staff-home');

await tap(adm, 'tab-people'); await adm.waitForTimeout(3000);
// Open the Disabled section so the list is photographed showing both parts —
// a closed collapsible documents nothing about what is inside it.
await tap(adm, 'students-disabled'); await adm.waitForTimeout(800);
await pair(adm, '11-students');

// One student's page: access, and the courses they are in.
await tap(adm, 'student-open-fatima.ahmed@example.com'); await adm.waitForTimeout(3000);
await pair(adm, '11b-student-page');

await home(adm);
await tap(adm, 'tab-people'); await adm.waitForTimeout(1500);
await tap(adm, 'segment-staff'); await adm.waitForTimeout(1200);
// The Disabled section open, as on the students figure.
await tap(adm, 'staff-disabled'); await adm.waitForTimeout(800);
await pair(adm, '12-staff-approvals');

await home(adm);
await tap(adm, 'tab-courses'); await adm.waitForTimeout(3000);
await tap(adm, 'cohorts-archived'); await adm.waitForTimeout(800);
await pair(adm, '13-cohorts');
// The cohort's own page — its settings (archiving lives here now) and courses.
await tap(adm, 'cohort-open-Autumn 2026'); await adm.waitForTimeout(3000);
await pair(adm, '14-courses');
await tap(adm, 'course-open-Hikam Foundations');
await adm.getByTestId('nav-sessions').waitFor({ timeout: 15000 });
await pair(adm, '15-course-detail');

// Assignments: the course's list, one assignment's page, grading — three
// columns on the computer — and the form for a new one.
await tap(adm, 'nav-coursework');
await adm.getByTestId('coursework-new').waitFor({ timeout: 15000 });
await adm.waitForTimeout(2000);
await pair(adm, '23-assignments');
await tap(adm, 'coursework-Memorize the first hikma');
await adm.getByTestId('coursework-tab-students').waitFor({ timeout: 15000 });
await adm.waitForTimeout(2000);
await pair(adm, '24-assignment-page');
await tap(adm, 'work-row-Bilal Khan');
await adm.getByTestId('grade-points').waitFor({ timeout: 15000 });
await adm.waitForTimeout(3000);
await pair(adm, '25-grade');
await adm.goBack({ waitUntil: 'domcontentloaded' });
await adm.getByTestId('coursework-tab-students').waitFor({ timeout: 15000 });
await adm.goBack({ waitUntil: 'domcontentloaded' });
await tap(adm, 'coursework-new');
await adm.getByTestId('coursework-instructions').waitFor({ timeout: 30000 });
await adm.waitForTimeout(1500);
await pair(adm, '26-new-assignment');
await adm.goBack({ waitUntil: 'domcontentloaded' });
await adm.getByTestId('coursework-new').waitFor({ timeout: 15000 });
await adm.goBack({ waitUntil: 'domcontentloaded' });
await adm.getByTestId('nav-sessions').waitFor({ timeout: 15000 });

await tap(adm, 'nav-sessions'); await adm.waitForTimeout(2500);
await pair(adm, '16-sessions');

// A session with NO recording yet, because that is the state the manual's "add
// the recording" step is written for — Session 3 below already has a published
// one, so the two buttons the text names appear in no other figure. Captured
// off the sessions list and backed out of it: the parent breadcrumb PUSHES the
// course, and a second course screen in the stack makes `nav-sessions` ambiguous.
await tap(adm, 'session-open-Session 7 — Today (recording pending)');
await adm.getByTestId('recording-upload').waitFor({ timeout: 15000 });
await adm.waitForTimeout(600);
await pair(adm, '17b-session-no-recording');
await adm.goBack({ waitUntil: 'domcontentloaded' });
await adm.getByTestId('sessions-add').waitFor({ timeout: 15000 });
await adm.waitForTimeout(1200);

// Session 3 — attendance taken (roster shown) + a published recording.
await tap(adm, 'session-open-Session 3 — Patience in Hardship');
await adm.getByTestId('recording-ledger').waitFor({ timeout: 15000 });
await adm.waitForTimeout(800);
await pair(adm, '17-session-detail');

// Its ledger — the accountable/attendees split.
await tap(adm, 'recording-ledger');
await adm.getByTestId('ledger-filter-all').waitFor({ timeout: 15000 });
await tap(adm, 'ledger-filter-all'); await adm.waitForTimeout(800);
await pair(adm, '18-recording-ledger');

// Override form on the first not-complete required student.
await tap(adm, 'ledger-filter-notComplete'); await adm.waitForTimeout(600);
// `prepare` runs at EACH size, before that size's capture — which is what makes
// the editor open in both figures rather than only the first.
// FAILS CLOSED, like `heightAbove`. Skipping silently left the previous run's
// PNG on disk and exited 0, so the manual would ship a figure of a screen the
// app no longer produces.
if (!(await adm.locator('[data-testid^="override-open-"]').first().count())) {
  throw new Error('no not-complete student to open an override on — figure 19 would be stale');
}
await pair(adm, '19-override-form', {
  prepare: async (p) => {
    // Only if none is open. The editor survives the resize between the two
    // shots, so clicking blindly opened a SECOND one at desktop width and the
    // figure showed two half-filled forms.
    if (await p.locator('[data-testid^="override-reason-"]').count()) return;
    const btn = p.locator('[data-testid^="override-open-"]').first();
    if (await btn.count()) await btn.click();
  },
});

// Attendance report (toggle: by session / by student).
await openHikam(adm);
await tap(adm, 'nav-attendance'); await adm.waitForTimeout(2000);
await pair(adm, '20-attendance-report');

await home(adm);
await tap(adm, 'tab-library'); await adm.waitForTimeout(3000);
await pair(adm, '21-library');

await home(adm);
await more(adm, 'more-audit'); await adm.waitForTimeout(1500);
await pair(adm, '22-audit');
await adm.context().close();

await browser.close();
console.log('done — screenshots in', DIR);
