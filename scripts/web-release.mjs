/**
 * Build the web bundle FOR DEPLOY, with Sentry source maps.
 *
 * Runs as the hosting predeploy. Four steps:
 *   1. Export with external source maps (`sabeel-ci build-web --source-maps`,
 *      through `web:export:maps`; plain `web:export` emits none). It checks the
 *      version, stamps the build and refuses an export that does not carry
 *      the stamped commit.
 *   2. Inject Sentry "debug IDs" into the JS and the maps. Debug IDs match a
 *      runtime error to its map with no release/version coordination.
 *   3. Upload the maps to the `sabeel-recording-web` Sentry project.
 *   4. DELETE the .map files from the deploy dir, so Firebase Hosting never
 *      serves them publicly — the maps live in Sentry, not on the open web. The
 *      shipped JS keeps its debug id, so events still symbolicate.
 *
 * The Sentry steps are skipped (with a note) when the gitignored
 * app/android/sentry.properties has no auth token — a fresh clone or CI can
 * still build and deploy, just without uploading maps. The token is read only by
 * sentry-cli, via SENTRY_PROPERTIES; it never passes through this script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'app', 'dist-web');
const PROPS = join(ROOT, 'app', 'android', 'sentry.properties');
const ORG = 'devnull-ke';
const WEB_PROJECT = 'sabeel-recording-web';

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/*
 * THE SHELL THAT RUNS THE DEV LOOP IS THE SHELL THAT DEPLOYS. Metro inlines
 * every `EXPO_PUBLIC_*` variable it finds at export time, so a terminal still
 * carrying `EXPO_PUBLIC_USE_EMULATORS=1` from an e2e run would ship a bundle
 * that points the live site at 127.0.0.1 — and nothing in the deploy would
 * say so. `smoke:prod` catches it after the fact; this refuses before.
 */
if (process.env.EXPO_PUBLIC_USE_EMULATORS) {
  throw new Error(
    '[web-release] EXPO_PUBLIC_USE_EMULATORS is set: this bundle would point at the emulators. Unset it and run again.',
  );
}
// Expo also reads the dotenv files in app/, and a flag left in one of those
// bakes in just the same.
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const file = join(ROOT, 'app', name);
  if (existsSync(file) && /^\s*EXPO_PUBLIC_USE_EMULATORS\s*=\s*\S/m.test(readFileSync(file, 'utf8'))) {
    throw new Error(`[web-release] app/${name} sets EXPO_PUBLIC_USE_EMULATORS: this bundle would point at the emulators.`);
  }
}

// 1. Export with source maps. The build label is `v<version> · <commit>`, with
// a `+` after the commit when the tree holds uncommitted changes; a deploy
// from such a tree says so on every screen that shows the label.
run('npm', ['run', 'web:export:maps', '-w', '@sabeel/app']);

// Does the token file carry an auth token? (Presence check only — the value is
// never read here; sentry-cli reads it itself.)
const hasToken =
  existsSync(PROPS) && /^auth\.token=\S/m.test(readFileSync(PROPS, 'utf8'));

if (hasToken) {
  const env = { ...process.env, SENTRY_PROPERTIES: PROPS };
  console.log('\n[web-release] injecting debug ids + uploading source maps to Sentry…');
  // inject takes a path, not org/project — call it without the trailing flags.
  run('npx', ['sentry-cli', 'sourcemaps', 'inject', DIST], { env });
  run('npx', ['sentry-cli', 'sourcemaps', 'upload', '--org', ORG, '--project', WEB_PROJECT, DIST], {
    env,
  });
} else {
  console.log('\n[web-release] no Sentry token — skipping source-map upload.');
}

// 4. Strip maps from the deploy dir so they are not served publicly.
let stripped = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.map')) {
      rmSync(p);
      stripped++;
    }
  }
};
if (existsSync(DIST)) walk(DIST);
console.log(`[web-release] stripped ${stripped} source map(s) from the deploy bundle.`);
// That they are not served is proved from the outside, by `npm run smoke:prod`
// — a re-walk of the same tree with the same predicate could not fail.
