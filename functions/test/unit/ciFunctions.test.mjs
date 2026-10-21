import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { callableAnswered, deletions, deployErrors, probeHealthy, sourceEndpoints } from '../../../scripts/ci-functions.mjs';

const workflow = readFileSync(new URL('../../../.github/workflows/functions-deploy.yml', import.meta.url), 'utf8');

describe('functions deploy guards', () => {
  it('reads each function and its trigger from the bundle', () => {
    const endpoints = sourceEndpoints({
      join: { __endpoint: { callableTrigger: {}, region: ['us-central1'] } },
      probe: { __endpoint: { httpsTrigger: {} } },
      nightly: { __endpoint: { scheduleTrigger: { schedule: 'every day 05:00' } } },
      onWrite: { __endpoint: { eventTrigger: {}, region: ['europe-west1'] } },
      helper: () => {},
    });
    expect(endpoints).toEqual([
      { name: 'join', region: 'us-central1', kind: 'callable' },
      { name: 'probe', region: 'us-central1', kind: 'https' },
      { name: 'nightly', region: 'us-central1', kind: 'schedule' },
      { name: 'onWrite', region: 'europe-west1', kind: 'event' },
    ]);
    expect(() => sourceEndpoints({ helper: () => {} })).toThrow(/registers no functions/);
  });

  it('names every live function a forced deploy would delete', () => {
    const source = [{ name: 'a' }, { name: 'b' }];
    expect(deletions(['a', 'b'], source)).toEqual([]);
    expect(deletions(['c', 'a', 'b', 'old'], source)).toEqual(['c', 'old']);
  });

  it('counts a callable as answering only when its own code replied', () => {
    const json = 'application/json; charset=utf-8';
    expect(callableAnswered(json, '{"error":{"message":"Sign in required.","status":"UNAUTHENTICATED"}}')).toBe(true);
    expect(callableAnswered(json, '{"result":{"exists":false}}')).toBe(true);
    expect(callableAnswered('text/html; charset=UTF-8', '<html><title>403 Forbidden</title></html>')).toBe(false);
    expect(callableAnswered(json, '{"message":"not a callable reply"}')).toBe(false);
    expect(callableAnswered(json, 'not json')).toBe(false);
    expect(callableAnswered(null, '')).toBe(false);
  });

  it('passes probeQueries only when every shape reads OK', () => {
    expect(probeHealthy('OK users by email\nOK open sessions\n')).toBe(true);
    expect(probeHealthy('OK users by email\nFAILED_PRECONDITION open sessions: index missing\n')).toBe(false);
    expect(probeHealthy('\n')).toBe(false);
  });

  it('ignores the scanners that GET every new revision, and nothing else', () => {
    const scanner = { textPayload: 'Error: Invalid request, unable to process.\n    at entryFromArgs' };
    const crash = { textPayload: "Error: Cannot find module 'file-type'" };
    const structured = { jsonPayload: { message: 'Unhandled error' } };
    expect(deployErrors([scanner, crash, structured])).toEqual([crash, structured]);
  });
});

describe('the functions deploy workflow', () => {
  it('is started by hand from main, and checks before it deploys', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|workflow_run|schedule):/m);
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/deploy:\n(?: {8}.*\n)*? {8}default: false/);
    expect(workflow).toContain('environment: functions');
  });

  it('plans before a forced deploy, and verifies after it', () => {
    const at = (text) => workflow.indexOf(text);
    expect(at('ci-functions.mjs require-ci')).toBeGreaterThan(-1);
    expect(at('ci-functions.mjs require-ci')).toBeLessThan(at('ci-functions.mjs plan'));
    expect(at('ci-functions.mjs plan')).toBeLessThan(at('--force'));
    expect(at('--force')).toBeLessThan(at('ci-functions.mjs verify'));
    expect(workflow.match(/firebase deploy[^\n]*--force/g)).toHaveLength(1);
    expect(workflow).toMatch(/--force\n/);
    expect(workflow).toMatch(/- name: Deploy the functions\n {8}if: inputs\.deploy\n/);
  });

  it('authenticates with the federated functions identity, never a key', () => {
    expect(workflow).toContain('vars.GCP_FUNCTIONS_WORKLOAD_IDENTITY_PROVIDER');
    expect(workflow).toContain('vars.GCP_FUNCTIONS_SERVICE_ACCOUNT');
    expect(workflow).not.toMatch(/credentials_json|GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN/);
  });
});
