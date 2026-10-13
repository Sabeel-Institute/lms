import { describe, expect, it } from 'vitest';
import { createGate } from './oneAtATime';

describe('one action at a time', () => {
  it('a second tap while the first is running does nothing', () => {
    const gate = createGate();
    expect(gate.begin('handIn')).toBe(true);
    expect(gate.begin('handIn')).toBe(false);
    // Another action on the same screen waits its turn too.
    expect(gate.begin('takeBack')).toBe(false);
    expect(gate.active).toBe('handIn');
  });

  it('opens again once the action has finished', () => {
    const gate = createGate();
    gate.begin('handIn');
    gate.end();
    expect(gate.active).toBe(null);
    expect(gate.begin('takeBack')).toBe(true);
  });
});
