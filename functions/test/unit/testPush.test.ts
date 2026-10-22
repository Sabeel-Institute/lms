import { describe, it, expect } from 'vitest';
import { recordingReadyMessage } from '@sabeel/shared';
import { testMessage } from '../../src/testPush';

/**
 * What a test push promises the person holding the phone: it is shown with
 * the words given, and a tap opens what it names, or the app. A test push
 * that names something this app's notifications never carry must not be sent
 * at all: it would prove nothing about a real one.
 */
describe('a test push', () => {
  it('with nothing named, opens the app', () => {
    expect(testMessage('Test push', 'Safe to dismiss', {})).toEqual({ title: 'Test push', body: 'Safe to dismiss', path: '' });
  });

  it('with a path, opens that path, as a notification does', () => {
    const real = recordingReadyMessage('Hikam Foundations', 'Session 5', '2026-10-30', 'rec1');
    const test = testMessage('Test push', 'Safe to dismiss', { path: real.path });
    expect(test).toEqual({ title: 'Test push', body: 'Safe to dismiss', path: real.path });
    expect(Object.keys(test ?? {}).sort()).toEqual(Object.keys(real).sort());
  });

  it('names nothing else: any other field gives no message', () => {
    expect(testMessage('Test push', 'Safe to dismiss', { screen: 'home' })).toBeNull();
    expect(testMessage('Test push', 'Safe to dismiss', { path: 'work/w1', courseId: 'c1' })).toBeNull();
  });
});
