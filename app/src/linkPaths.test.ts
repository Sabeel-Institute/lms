import { describe, expect, it } from 'vitest';
import { getStateFromPath } from '@react-navigation/core';
import { pushPaths } from '@sabeel/shared';
import { STAFF_PATHS, STUDENT_PATHS } from './linkPaths';

/**
 * A notification's path is a promise of a screen: the server builds it with
 * `pushPaths`, and the app opens it through these tables — on Android when it
 * is tapped, in a browser as the link's address. A path the tables do not know
 * opens nothing, so each one is resolved here through the table of the people
 * who are sent it.
 */
const leaf = (path: string, screens: object) => {
  const state = getStateFromPath(path, { screens } as never);
  const route = state?.routes[state.routes.length - 1];
  return route ? { name: route.name, params: route.params } : null;
};

describe('where a tapped notification lands', () => {
  it('an assignment message opens the student’s assignment', () => {
    expect(leaf(pushPaths.work('cw1'), STUDENT_PATHS)).toEqual({ name: 'Work', params: { courseworkId: 'cw1' } });
  });

  it('a recording message opens the player', () => {
    expect(leaf(pushPaths.recording('r1'), STUDENT_PATHS)).toEqual({ name: 'Player', params: { recordingId: 'r1' } });
  });

  it('a register not taken opens the session, for staff', () => {
    expect(leaf(pushPaths.session('c1', 's1'), STAFF_PATHS)).toEqual({
      name: 'SessionDetail',
      params: { courseId: 'c1', sessionId: 's1' },
    });
  });

  it('a path for the other population opens nothing', () => {
    expect(leaf(pushPaths.work('cw1'), STAFF_PATHS)).toBe(null);
  });
});
