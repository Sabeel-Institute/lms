import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Turn a screens sweep into something a person can review: one page with every
 * screen at every width, the checks that failed on each, and what changed
 * against a baseline sweep, before / after / difference.
 *
 *   node scripts/screens-report.mjs <shots dir> [--baseline <dir> | --baseline-from-main] [--out <dir>]
 *
 * <shots dir> is a sweep's output: `<width>px-<screen>.png` files and the
 * sweep's results.json. --baseline-from-main downloads the report of the latest
 * successful CI run on main (gh, with actions read access) and compares against
 * its screens. Writes <out>/index.html and <out>/manifest.json, the same data
 * for an agent; in CI also a summary on the run's page. Always exits 0: the
 * sweep's own exit status is what passes or fails a run.
 */

const SHOT = /^(\d+)px-(.+)\.png$/;

/** A sweep screenshot's width and screen, from its file name; null for anything else. */
export function parseShot(file) {
  const match = SHOT.exec(file);
  return match ? { file, width: Number(match[1]), screen: match[2] } : null;
}

/**
 * The checks about each screenshot. A sweep names a check `<tag> / <screen>…`
 * and the screenshot `<tag>-<screen>.png`; a check belongs to the shot whose
 * screen its name begins with, the longest such when names nest.
 */
export function checksByShot(files, results) {
  const byShot = new Map(files.map((file) => [file, []]));
  const other = [];
  for (const result of results) {
    const at = result.name.indexOf(' / ');
    const tag = at > 0 ? result.name.slice(0, at) : null;
    const rest = at > 0 ? result.name.slice(at + 3) : '';
    let best = null;
    for (const file of files) {
      const name = file.replace(/\.png$/, '');
      if (!tag || !name.startsWith(`${tag}-`)) continue;
      const screen = name.slice(tag.length + 1);
      const fits = rest === screen || rest.startsWith(`${screen} `);
      if (fits && (!best || screen.length > best.screen.length)) best = { file, screen };
    }
    if (best) byShot.get(best.file).push(result);
    else other.push(result);
  }
  return { byShot, other };
}

/** Changed pixels between two PNGs: null when identical, the share changed otherwise. */
export function compare(beforeBytes, afterBytes, diffPath) {
  if (Buffer.compare(beforeBytes, afterBytes) === 0) return null;
  const before = PNG.sync.read(beforeBytes);
  const after = PNG.sync.read(afterBytes);
  if (before.width !== after.width || before.height !== after.height) {
    return { ratio: 1, note: `size ${before.width}×${before.height} → ${after.width}×${after.height}` };
  }
  const diff = new PNG({ width: after.width, height: after.height });
  const changed = pixelmatch(before.data, after.data, diff.data, after.width, after.height, { threshold: 0.1 });
  if (!changed) return null;
  writeFileSync(diffPath, PNG.sync.write(diff));
  return { ratio: changed / (after.width * after.height), note: `${changed} pixels` };
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const percent = (ratio) => (ratio >= 0.001 ? `${(ratio * 100).toFixed(1)}%` : '<0.1%');

function option(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

/** The screens of the latest successful main run that kept a report, downloaded; null when there is none. */
function baselineFromMain() {
  const repository = process.env.GITHUB_REPOSITORY
    ?? execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).trim();
  const runs = JSON.parse(execFileSync('gh', ['run', 'list', '-R', repository, '--workflow', 'ci.yml', '--branch', 'main',
    '--status', 'success', '--limit', '10', '--json', 'databaseId,headSha'], { encoding: 'utf8' }));
  for (const run of runs) {
    const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), `screens-baseline-${run.databaseId}`);
    rmSync(directory, { recursive: true, force: true });
    try {
      execFileSync('gh', ['run', 'download', String(run.databaseId), '-R', repository, '-n', 'screens-report', '-D', directory],
        { stdio: 'ignore' });
    } catch {
      continue;
    }
    if (existsSync(join(directory, 'screens'))) return { directory: join(directory, 'screens'), label: `main @ ${run.headSha.slice(0, 7)}` };
  }
  return null;
}

function page({ title, shots, other, baseline, removed, totals }) {
  const thumb = (shot, src = `screens/${shot.file}`) =>
    `<a href="${src}" target="_blank"><img loading="lazy" src="${src}" alt="${escape(shot.file)}"></a>`;
  const badge = (shot) => {
    const failed = shot.checks.filter((check) => !check.ok).length;
    const change = shot.change === 'new' ? '<b class="new">new</b>'
      : shot.change ? `<b class="changed">changed ${percent(shot.change.ratio)}</b>` : '';
    return `${failed ? `<b class="fail">${failed} failed</b>` : shot.checks.length ? '<b class="ok">checks pass</b>' : ''}${change}`;
  };
  const failing = shots.filter((shot) => shot.checks.some((check) => !check.ok));
  const changed = shots.filter((shot) => shot.change && shot.change !== 'new').sort((a, b) => b.change.ratio - a.change.ratio);
  const groups = new Map();
  for (const shot of shots) groups.set(shot.screen, [...(groups.get(shot.screen) ?? []), shot]);
  const section = (heading, body) => `<section><h2>${heading}</h2>${body}</section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>
:root{--bg:#f7f5f2;--fg:#1d1b19;--muted:#6b645c;--card:#fff;--line:#ddd6cd;--fail:#b3261e;--ok:#2e7d32;--changed:#8a5a00;--new:#1f5fa8}
@media (prefers-color-scheme:dark){:root{--bg:#171513;--fg:#ece7e1;--muted:#a59d93;--card:#211e1b;--line:#3a352f;--fail:#f2b8b5;--ok:#9ccf9f;--changed:#f3c46b;--new:#9ec2f0}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p{margin:4px 0;color:var(--muted)}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:12px;flex-wrap:wrap;align-items:center;z-index:1}
input[type=search]{flex:1;min-width:200px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.group{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin:10px 0}
.group h3{margin:0 0 8px;font-size:14px}.row{display:flex;gap:10px;overflow-x:auto}
figure{margin:0;flex:0 0 auto}figcaption{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
img{display:block;height:340px;max-width:420px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:4px;background:#fff}
b{font-weight:600}.fail{color:var(--fail)}.ok{color:var(--ok)}.changed{color:var(--changed)}.new{color:var(--new)}
ul.checks{margin:6px 0 0;padding-left:18px;font-size:12px}ul.checks li.fail{color:var(--fail)}
.hidden{display:none}
</style></head><body>
<h1>${escape(title)}</h1>
<p>${totals.shots} screenshots of ${groups.size} screens · ${totals.passed} of ${totals.checks} checks passed${baseline
    ? ` · compared with ${escape(baseline)}: ${changed.length} changed, ${totals.added} new, ${removed.length} gone` : ' · no baseline to compare with'}</p>
<div class="bar"><input type="search" id="filter" placeholder="Filter screens, e.g. manager-course or 320px">
<label><input type="checkbox" id="attention"> only failed or changed</label></div>
${failing.length ? section(`Failed checks (${failing.length} screenshots)`, failing.map((shot) => `<div class="group" data-key="${escape(shot.file)}" data-attention="1">
<h3>${escape(shot.file)}</h3><div class="row"><figure>${thumb(shot)}</figure></div>
<ul class="checks">${shot.checks.filter((c) => !c.ok).map((c) => `<li class="fail">${escape(c.name)}${c.detail ? ` — ${escape(c.detail)}` : ''}</li>`).join('')}</ul></div>`).join('')) : ''}
${other.some((c) => !c.ok) ? section('Other failed checks', `<ul class="checks">${other.filter((c) => !c.ok)
    .map((c) => `<li class="fail">${escape(c.name)}${c.detail ? ` — ${escape(c.detail)}` : ''}</li>`).join('')}</ul>`) : ''}
${changed.length ? section(`Changed since ${escape(baseline)} (${changed.length})`, changed.map((shot) => `<div class="group" data-key="${escape(shot.file)}" data-attention="1">
<h3>${escape(shot.file)} <b class="changed">${percent(shot.change.ratio)}</b> <span class="muted">${escape(shot.change.note)}</span></h3>
<div class="row"><figure>${thumb(shot, `baseline/${shot.file}`)}<figcaption>before</figcaption></figure>
<figure>${thumb(shot)}<figcaption>after</figcaption></figure>${shot.change.diff
    ? `<figure>${thumb(shot, `diff/${shot.file}`)}<figcaption>difference</figcaption></figure>` : ''}</div></div>`).join('')) : ''}
${removed.length ? section(`Gone since ${escape(baseline)} (${removed.length})`, `<ul class="checks">${removed.map((file) => `<li>${escape(file)}</li>`).join('')}</ul>`) : ''}
${section('Every screen', [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([screen, list]) => `<div class="group" data-key="${escape(screen)} ${list.map((s) => `${s.width}px`).join(' ')}"
 data-attention="${list.some((s) => s.change || s.checks.some((c) => !c.ok)) ? 1 : 0}"><h3>${escape(screen)}</h3><div class="row">
${list.sort((a, b) => a.width - b.width).map((shot) => `<figure>${thumb(shot)}<figcaption>${shot.width}px ${badge(shot)}</figcaption></figure>`).join('')}
</div></div>`).join(''))}
<script>
const filter=document.getElementById('filter'),attention=document.getElementById('attention');
function apply(){const q=filter.value.trim().toLowerCase();for(const g of document.querySelectorAll('.group')){
g.classList.toggle('hidden',(q&&!g.dataset.key.toLowerCase().includes(q))||(attention.checked&&g.dataset.attention!=='1'))}}
filter.addEventListener('input',apply);attention.addEventListener('change',apply);
</script></body></html>
`;
}

function main() {
  const shotsDir = process.argv[2];
  if (!shotsDir || !existsSync(shotsDir)) {
    throw new Error('usage: node scripts/screens-report.mjs <shots dir> [--baseline <dir> | --baseline-from-main] [--out <dir>]');
  }
  const out = resolve(option('--out') ?? join(shotsDir, '..', 'screens-report'));
  let baseline = option('--baseline') ? { directory: option('--baseline'), label: basename(resolve(option('--baseline'))) } : null;
  if (process.argv.includes('--baseline-from-main')) {
    baseline = baselineFromMain();
    if (!baseline) console.log('No report from a successful main run to compare with');
  }

  const files = readdirSync(shotsDir).filter((file) => parseShot(file)).sort();
  const resultsPath = join(shotsDir, 'results.json');
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : [];
  const { byShot, other } = checksByShot(files, results);

  rmSync(out, { recursive: true, force: true });
  for (const directory of ['screens', 'baseline', 'diff']) mkdirSync(join(out, directory), { recursive: true });
  const shots = files.map((file) => {
    const shot = { ...parseShot(file), checks: byShot.get(file), change: null };
    const bytes = readFileSync(join(shotsDir, file));
    writeFileSync(join(out, 'screens', file), bytes);
    if (baseline) {
      const before = join(baseline.directory, file);
      if (!existsSync(before)) shot.change = 'new';
      else {
        const change = compare(readFileSync(before), bytes, join(out, 'diff', file));
        if (change) {
          copyFileSync(before, join(out, 'baseline', file));
          shot.change = { ...change, diff: existsSync(join(out, 'diff', file)) };
        }
      }
    }
    return shot;
  });
  const removed = baseline ? readdirSync(baseline.directory).filter((file) => parseShot(file) && !files.includes(file)).sort() : [];
  const passed = results.filter((result) => result.ok).length;
  const totals = { shots: shots.length, checks: results.length, passed, added: shots.filter((s) => s.change === 'new').length };
  const title = `Screens sweep${process.env.GITHUB_REPOSITORY ? ` — ${process.env.GITHUB_REPOSITORY}` : ''}${process.env.GITHUB_SHA ? ` @ ${process.env.GITHUB_SHA.slice(0, 7)}` : ''}`;

  writeFileSync(join(out, 'index.html'), page({ title, shots, other, baseline: baseline?.label, removed, totals }));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ title, baseline: baseline?.label ?? null, totals, removed, other, shots }, null, 2));

  const changed = shots.filter((s) => s.change && s.change !== 'new').sort((a, b) => b.change.ratio - a.change.ratio);
  const failedChecks = results.filter((result) => !result.ok);
  const summary = [
    `### ${title}`,
    `${totals.shots} screenshots · ${passed} of ${results.length} checks passed${baseline
      ? ` · compared with ${baseline.label}: ${changed.length} changed, ${totals.added} new, ${removed.length} gone` : ''}`,
    ...(failedChecks.length ? ['', '**Failed checks**', ...failedChecks.slice(0, 30).map((r) => `- ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)] : []),
    ...(changed.length ? ['', '**Changed screens**', ...changed.slice(0, 30).map((s) => `- \`${s.file}\` ${percent(s.change.ratio)}`)] : []),
    ...(changed.length > 30 ? [`- …and ${changed.length - 30} more`] : []),
    '',
    process.env.GITHUB_RUN_ID
      ? `Open the full report: \`gh run download ${process.env.GITHUB_RUN_ID} -R ${process.env.GITHUB_REPOSITORY} -n screens-report\`, then \`index.html\`.`
      : `Report: ${join(out, 'index.html')}`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
