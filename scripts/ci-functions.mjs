import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The guards around a functions deploy, the same from a terminal as from
 * .github/workflows/functions-deploy.yml:
 *
 *   node scripts/ci-functions.mjs require-ci        # CI passed on this commit
 *   node scripts/ci-functions.mjs plan              # build; refuse to delete a live function
 *   node scripts/ci-functions.mjs verify --since T  # after a deploy: callables, probe, error logs
 *
 * The project is FIREBASE_PROJECT_ID. Google calls go through gcloud's active
 * credentials: the workflow's federated identity in CI, your own account here.
 * `verify` calls probeQueries when the bundle has it, with PROBE_TOKEN.
 */

const run = (program, args, options = {}) => execFileSync(program, args, { stdio: 'inherit', ...options });
const output = (program, args, options = {}) =>
  execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();

const KINDS = [
  ['callableTrigger', 'callable'],
  ['httpsTrigger', 'https'],
  ['eventTrigger', 'event'],
  ['scheduleTrigger', 'schedule'],
  ['blockingTrigger', 'blocking'],
  ['taskQueueTrigger', 'task'],
];

/** The functions a built bundle registers, from its exports' `__endpoint`s. */
export function sourceEndpoints(exported) {
  const endpoints = Object.entries(exported)
    .filter(([, value]) => value?.__endpoint)
    .map(([name, { __endpoint: endpoint }]) => ({
      name,
      region: endpoint.region?.[0] ?? 'us-central1',
      kind: KINDS.find(([key]) => endpoint[key])?.[1] ?? 'other',
    }));
  if (!endpoints.length) throw new Error('The backend bundle registers no functions');
  return endpoints;
}

/** Live functions the source no longer has: what `firebase deploy --force` would delete. */
export function deletions(deployedNames, endpoints) {
  const inSource = new Set(endpoints.map((endpoint) => endpoint.name));
  return deployedNames.filter((name) => !inSource.has(name)).sort();
}

/**
 * Whether a callable's own code answered. A Firebase JSON error (sign in
 * required, a missing argument) or a result means it ran; Cloud Run's HTML 403,
 * a callable whose invoker binding is missing, never reaches the code.
 */
export function callableAnswered(contentType, body) {
  if (!/application\/json/.test(contentType ?? '')) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error?.status === 'string' || 'result' in (parsed ?? {});
  } catch {
    return false;
  }
}

/** probeQueries answers one line per query shape, each `OK …` when it is servable. */
export function probeHealthy(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith('OK'));
}

/**
 * Error entries that count against a deploy. Requests from scanners that GET
 * every new revision's URL are answered "Invalid request, unable to process" by
 * the callable wrapper and logged as errors after every deploy; nothing of ours
 * sends a GET to a callable.
 */
export function deployErrors(entries) {
  return entries.filter((entry) => !String(entry.textPayload ?? '').includes('Invalid request, unable to process'));
}

function project() {
  const id = process.env.FIREBASE_PROJECT_ID;
  if (!id || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id)) throw new Error('Set FIREBASE_PROJECT_ID to the project to deploy');
  return id;
}

function loadEndpoints() {
  run('npm', ['run', 'build'], { cwd: 'functions' });
  const listed = output(process.execPath, ['-e',
    'const m = require("./lib/index.js"); console.log(JSON.stringify(Object.fromEntries(Object.entries(m)'
    + '.filter(([, v]) => v && v.__endpoint).map(([n, v]) => [n, { __endpoint: v.__endpoint }]))))'],
  { cwd: 'functions', env: { ...process.env, GCLOUD_PROJECT: 'demo-sabeel-ci', FIREBASE_CONFIG: '{"projectId":"demo-sabeel-ci"}' } });
  return sourceEndpoints(JSON.parse(listed.split('\n').at(-1)));
}

function requireCi() {
  const sha = process.env.GITHUB_SHA ?? output('git', ['rev-parse', 'HEAD']);
  const repository = process.env.GITHUB_REPOSITORY ?? output('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const count = Number(output('gh', ['api', `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=1`,
    '--jq', '.total_count']));
  if (!(count > 0)) throw new Error(`CI has not passed on ${sha.slice(0, 7)}; deploy only a commit CI has passed`);
  console.log(`CI passed on ${sha.slice(0, 7)}`);
}

function plan() {
  const id = project();
  const endpoints = loadEndpoints();
  const deployed = output('gcloud', ['functions', 'list', '--project', id, '--format=value(name)'])
    .split('\n').filter(Boolean).map((name) => name.split('/').at(-1));
  const removed = deletions(deployed, endpoints);
  if (removed.length) {
    throw new Error(`The source no longer has ${removed.join(', ')}, which ${id} still runs. `
      + 'This workflow never deletes a function: delete it by hand (firebase functions:delete) once nothing calls it.');
  }
  const added = endpoints.filter((endpoint) => !deployed.includes(endpoint.name)).map((endpoint) => endpoint.name);
  console.log(`${endpoints.length} functions in the bundle, ${deployed.length} live in ${id}; none would be deleted`);
  if (added.length) console.log(`New functions, created by this deploy: ${added.join(', ')}`);
}

async function call(url, init, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }).catch((error) => ({ error }));
    const retry = response.error || response.status === 429 || response.status >= 500;
    if (!retry || attempt === attempts) return response;
    await new Promise((done) => setTimeout(done, attempt * 5_000));
  }
}

async function verify() {
  const id = project();
  const since = process.argv[process.argv.indexOf('--since') + 1];
  if (!process.argv.includes('--since') || Number.isNaN(Date.parse(since))) throw new Error('verify needs --since <ISO time the deploy started>');
  const endpoints = loadEndpoints();
  const problems = [];

  const callables = endpoints.filter((endpoint) => endpoint.kind === 'callable');
  for (let i = 0; i < callables.length; i += 6) {
    await Promise.all(callables.slice(i, i + 6).map(async ({ name, region }) => {
      const response = await call(`https://${region}-${id}.cloudfunctions.net/${name}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"data":{}}' });
      const body = response.error ? '' : await response.text();
      if (response.error || !callableAnswered(response.headers.get('content-type'), body)) {
        problems.push(`${name} did not answer for itself (${response.error?.message ?? `${response.status} ${body.slice(0, 80)}`})`);
      }
    }));
  }
  console.log(`${callables.length - problems.length} of ${callables.length} callables answered for themselves`);

  const probe = endpoints.find((endpoint) => endpoint.name === 'probeQueries');
  if (probe) {
    const token = process.env.PROBE_TOKEN;
    if (!token) problems.push('probeQueries is deployed but PROBE_TOKEN is not set');
    else {
      const response = await call(`https://${probe.region}-${id}.cloudfunctions.net/probeQueries?token=${encodeURIComponent(token)}`, {});
      const text = response.error ? '' : await response.text();
      if (response.error || response.status !== 200 || !probeHealthy(text)) {
        problems.push(`probeQueries reported a problem:\n${text.split('\n').filter((line) => !line.startsWith('OK')).join('\n')}`);
      } else console.log(`probeQueries: all ${text.split('\n').filter(Boolean).length} query shapes OK`);
    }
  }

  // Logs reach Cloud Logging seconds after the request that wrote them.
  await new Promise((done) => setTimeout(done, 30_000));
  const filter = `severity>=ERROR AND timestamp>="${new Date(since).toISOString()}"`
    + ' AND (resource.type="cloud_run_revision" OR resource.type="cloud_function")'
    + ' AND NOT logName:"cloudaudit.googleapis.com"';
  const entries = deployErrors(JSON.parse(output('gcloud', ['logging', 'read', filter, '--project', id,
    '--limit', '50', '--format=json'])));
  for (const entry of entries) {
    const service = entry.resource?.labels?.service_name ?? entry.resource?.labels?.function_name ?? '?';
    const message = String(entry.textPayload ?? entry.jsonPayload?.message ?? '').split('\n')[0];
    problems.push(`error logged by ${service} at ${entry.timestamp}: ${message.slice(0, 160)}`);
  }
  if (!entries.length) console.log('No errors logged by the functions since the deploy started');

  if (problems.length) throw new Error(`After the deploy:\n- ${problems.join('\n- ')}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const task = process.argv[2];
  if (task === 'require-ci') requireCi();
  else if (task === 'plan') plan();
  else if (task === 'verify') await verify();
  else throw new Error('Unknown functions task: use require-ci, plan or verify');
}
