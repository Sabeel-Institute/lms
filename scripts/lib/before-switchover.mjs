/**
 * Refuse to run once this project holds the institute's real records.
 *
 * The switchover seed copies the live app's cohorts in and, once its counts
 * agree, writes the day it did so to `config/app.realDataSince`. From then on
 * a demo seed would put invented hand-ins, grades and listening on real
 * students' records, and the legacy seed would wipe everything made here
 * since and put the old copy back. Each calls this before reading anything;
 * the demo wipe is safe either way (it removes only what carries the demo
 * marks).
 *
 * The marker lives in the project, not in this checkout, so a stale checkout
 * or another machine is refused too. `config/app` is readable by anyone (the
 * app reads it before sign-in), so the check needs no login.
 *
 * `replacing` is the seed's own way past, for redoing a copy that went wrong
 * before anyone used it: it must name the day of the copy being replaced, so
 * it cannot be passed by habit.
 */
import { APP_CONFIG_DOC, COLLECTIONS, FIREBASE_PROJECT_ID } from '@sabeel/shared';

export async function refuseOnceRealData(script, harm, { replacing } = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${COLLECTIONS.config}/${APP_CONFIG_DOC}`;
  const res = await fetch(url);
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`${script}: could not read config/app to check for real data (${res.status}); refusing`);
  const since = (await res.json()).fields?.realDataSince?.stringValue;
  if (!since) return;
  if (replacing !== undefined && replacing === since) {
    console.log(`${script}: replacing the copy of ${since}, as asked.`);
    return;
  }
  console.error(`${script}: refused. This project has held the institute's real records since ${since}, and ${harm}.`);
  process.exit(2);
}
