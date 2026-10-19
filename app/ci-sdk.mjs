import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function compatibleVersion(installed, recommended) {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(installed);
  const expected = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(recommended);
  if (!actual || !expected) return false;
  const [actualMajor, actualMinor, actualPatch] = actual.slice(1).map(Number);
  const [major, minor, patch] = expected.slice(2).map(Number);
  if (actualMajor !== major) return false;
  if (expected[1] === '^' && major > 0) {
    return actualMinor > minor || (actualMinor === minor && actualPatch >= patch);
  }
  if (actualMinor !== minor || actualPatch < patch) return false;
  return expected[1] !== '^' || major !== 0 || minor !== 0 || actualPatch === patch;
}

export function sdkProblems(recommended, installed) {
  return Object.entries(installed).flatMap(([name, version]) => {
    const expected = recommended[name];
    return expected && !compatibleVersion(version, expected)
      ? [name + ' ' + version + ' is outside the Expo SDK recommendation ' + expected] : [];
  });
}

export function checkSdk() {
  const require = createRequire(resolve('app/package.json'));
  const expoPath = require.resolve('expo/package.json');
  const recommended = json(join(dirname(expoPath), 'bundledNativeModules.json'));
  const manifest = json('app/package.json');
  const installed = {};
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (recommended[name]) installed[name] = json(require.resolve(name + '/package.json')).version;
  }
  if (!installed.react || !installed['react-native']) throw new Error('Core SDK versions were not checked');
  const reactFamily = installed.react.split('.').slice(0, 2).join('.');
  if (manifest.devDependencies?.['@types/react']) {
    recommended['@types/react'] = '~' + reactFamily + '.0';
    installed['@types/react'] = json(require.resolve('@types/react/package.json')).version;
  }
  const problems = sdkProblems(recommended, installed);
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('Expo SDK dependency ranges verified; same-minor native patch updates are allowed');
}
