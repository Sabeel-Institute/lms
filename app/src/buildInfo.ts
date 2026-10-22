import { versionCodeOf } from '@sabeel/shared';
import { BUILD_INFO } from './build-info';

/**
 * Build identity shown on the sign-in screen (see SignInScreen).
 *
 * Faisal's standing rule: every app surfaces its version and build commit on the
 * login screen, so a screenshot of a problem always says which build produced
 * it. Both come from `build-info.ts`, which `sabeel-ci build-info` writes from
 * `app.json`'s version and HEAD's commit at every build (`prepare`, `start`,
 * `android`, `build-web`, `build-aab`, `build-ios`), with a `+` after the commit
 * when the tree held uncommitted changes. It is gitignored: a committed copy
 * would name the commit before its own.
 */
export const BUILD_LABEL = `v${BUILD_INFO.version} · ${BUILD_INFO.commit}`;

/**
 * The `versionCode` this bundle was built as — what the update gate compares
 * with the institute's floor. Computed from the version as build.gradle
 * computes the APK's, and the iPhone build carries the same number, so the
 * bundle and the binary it ships in cannot disagree.
 */
export const BUILD_VERSION_CODE: number = versionCodeOf(BUILD_INFO.version);
