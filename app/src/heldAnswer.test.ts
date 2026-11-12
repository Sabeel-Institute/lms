import { describe, expect, it } from 'vitest';
import { heldFor } from './heldAnswer';

/*
 * AN ANSWER IS FOR THE INPUTS IT WAS GIVEN FOR. A live hook's state is set by
 * an effect, a render after its inputs change; the render in between asked
 * about recording B and was handed recording A's answer, and the docked bar
 * closed B as revoked because A's window had ended.
 */
describe('a live answer held across a change of subject', () => {
  const held = { value: 'A’s record', resolved: true, deps: ['uid', 'A'] };

  it('is the answer while the inputs are the ones it answers', () => {
    expect(heldFor(held, ['uid', 'A'], null)).toEqual({ value: 'A’s record', resolved: true, deps: ['uid', 'A'] });
  });

  it('is no answer yet once they change, in that same render', () => {
    expect(heldFor(held, ['uid', 'B'], null)).toEqual({ value: null, resolved: false });
    expect(heldFor(held, ['uid'], null)).toEqual({ value: null, resolved: false });
  });
});
