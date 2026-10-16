#!/usr/bin/env node
/**
 * May this build go to TestFlight?
 *
 *     node scripts/testflight-check.mjs <bundle-id> <version> <build-number>
 *
 * Apple takes a build number once per version, each higher than the last, and
 * says so only after an upload has run its course. This asks first, so a
 * build made without a bump fails the TestFlight step in seconds with what to
 * do about it.
 *
 * Exit 0: the number is free. 1: Apple already has this build number, or a
 * higher one, for this version: raise `expo.ios.buildNumber` in app/app.json
 * and build again. 2: bad arguments, or App Store Connect did not answer.
 *
 * Authenticates with the App Store Connect API key named by ASC_KEY_ID and
 * ASC_ISSUER_ID, read from ASC_KEY_PATH, else
 * ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8. Reads only.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [bundleId, version, build] = process.argv.slice(2);
if (!bundleId || !version || !/^\d+$/.test(build ?? '')) {
  console.error('usage: testflight-check.mjs <bundle-id> <version> <build-number>');
  process.exit(2);
}
const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer } = process.env;
if (!keyId || !issuer) {
  console.error('ASC_KEY_ID and ASC_ISSUER_ID must be set');
  process.exit(2);
}
const keyPath = process.env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;

// App Store Connect's token: ES256 over the key, at most 20 minutes long, in
// JOSE's raw r||s form (node's default DER is refused).
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
const signature = sign('sha256', Buffer.from(unsigned), {
  key: createPrivateKey(readFileSync(keyPath)),
  dsaEncoding: 'ieee-p1363',
});
const token = `${unsigned}.${signature.toString('base64url')}`;

async function get(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`App Store Connect answered ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
    process.exit(2);
  }
  return res.json();
}

const apps = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
if (!app) {
  console.error(`App Store Connect has no app with bundle id ${bundleId}; create its record first.`);
  process.exit(2);
}
const builds = await get(
  `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version&limit=200`,
);
const taken = builds.data.map((b) => Number(b.attributes.version)).filter(Number.isFinite);
const highest = taken.length ? Math.max(...taken) : 0;

if (Number(build) <= highest) {
  console.error(
    `Version ${version} already has build ${highest} on App Store Connect, so build ${build} cannot go up.\n` +
      `Raise expo.ios.buildNumber in app/app.json above ${highest}, commit, and build again.`,
  );
  process.exit(1);
}
console.log(`Build ${build} of version ${version} is free (highest so far: ${highest || 'none'}).`);
