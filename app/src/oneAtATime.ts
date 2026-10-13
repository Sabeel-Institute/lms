import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One action at a time.
 *
 * A `busy` state with `disabled={busy}` is a frame late: two taps inside one
 * frame both run before React re-renders, so a double tap posts an assignment
 * twice, or hands work in and then shows the second call's refusal as an
 * error over work that went in. The gate is a plain synchronous flag; state is
 * kept only for rendering (the skill's "A `busy` flag is state" entry).
 */
export function createGate() {
  let active: string | null = null;
  return {
    /** Claim the gate for `key`; false when something else holds it. */
    begin(key: string): boolean {
      if (active !== null) return false;
      active = key;
      return true;
    },
    end(): void {
      active = null;
    },
    get active(): string | null {
      return active;
    },
  };
}

/**
 * The gate for a screen: `run(key, fn)` runs `fn` unless another action is
 * running, and `active` names the running one for the button that shows it.
 * Errors are the caller's: `fn` catches what it wants to show.
 */
export function useOneAtATime() {
  const gate = useRef(createGate()).current;
  const [active, setActive] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = useCallback(
    async (key: string, fn: () => Promise<void>): Promise<void> => {
      if (!gate.begin(key)) return;
      setActive(key);
      try {
        await fn();
      } finally {
        gate.end();
        if (mounted.current) setActive(null);
      }
    },
    [gate],
  );
  return { active, run };
}
