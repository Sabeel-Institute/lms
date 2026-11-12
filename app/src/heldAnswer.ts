/**
 * A live answer, and the subscription inputs it answers (`liveQuery.ts`).
 * Pure, and apart from the hooks, so the node-only unit suite can hold it.
 */
export interface Held<T> {
  value: T;
  resolved: boolean;
  deps: readonly unknown[];
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * THE ANSWER FOR THESE INPUTS, or none yet: what a held answer is worth to the
 * render asking. An answer to other inputs is nobody's answer here.
 */
export function heldFor<T>(held: Held<T>, deps: readonly unknown[], empty: T): { value: T; resolved: boolean } {
  return sameInputs(held.deps, deps) ? held : { value: empty, resolved: false };
}
