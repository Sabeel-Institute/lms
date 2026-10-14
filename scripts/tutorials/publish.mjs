/**
 * PUBLISH THE HELP FILMS to the media bucket, under `help/`: each film's MP4
 * and its captions, for both cuts. Private, as everything in the bucket is —
 * the app plays a film only on links `getHelpVideoUrl` signs for the person
 * watching.
 *
 *   node scripts/tutorials/publish.mjs --from <dir of films> [--only id,id]
 *
 * Through wrangler, signed in to the bucket's Cloudflare account
 * (`npx wrangler login`). It checks everything it was asked for is there, both
 * cuts and their captions, before it sends any of it, so a half-made set is
 * never half published. The bucket is the one the functions use
 * (`functions/.env.oursabeel-lms`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HELP_VARIANTS, HELP_VIDEOS, helpVideoKey } from '@sabeel/shared';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.from) {
  console.error('usage: publish.mjs --from <dir of films> [--only a,b]');
  process.exit(2);
}
const FROM = resolve(args.from);
const env = readFileSync(new URL('../../functions/.env.oursabeel-lms', import.meta.url), 'utf8');
const BUCKET = /^MEDIA_BUCKET=(.+)$/m.exec(env)?.[1]?.trim();
if (!BUCKET) {
  console.error('MEDIA_BUCKET is not set in functions/.env.oursabeel-lms');
  process.exit(1);
}
const only = new Set((args.only ?? '').split(',').filter(Boolean));
for (const id of only) {
  if (!HELP_VIDEOS.some((v) => v.id === id)) {
    console.error(`--only names no film: ${id}`);
    process.exit(2);
  }
}

const files = HELP_VIDEOS.filter((v) => !only.size || only.has(v.id)).flatMap((v) =>
  HELP_VARIANTS.flatMap((variant) => [
    { key: helpVideoKey(v.id, variant, 'video'), path: join(FROM, `${v.id}-${variant}.mp4`), type: 'video/mp4' },
    { key: helpVideoKey(v.id, variant, 'captions'), path: join(FROM, `${v.id}-${variant}.vtt`), type: 'text/vtt' },
  ]),
);
const absent = files.filter((f) => !existsSync(f.path)).map((f) => f.path);
if (absent.length) {
  console.error(`not there, so nothing sent:\n  ${absent.join('\n  ')}`);
  process.exit(1);
}
for (const f of files) {
  execFileSync(
    'npx',
    ['--yes', 'wrangler@4', 'r2', 'object', 'put', `${BUCKET}/${f.key}`, '--file', f.path, '--content-type', f.type, '--remote'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  console.log(`  ${f.key}`);
}
console.log(`${files.length} file(s) in ${BUCKET}/help/`);
