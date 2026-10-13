/**
 * Save-as-you-type, made safe to leave.
 *
 * A debounce on its own loses work: the timer is cleared when the screen goes,
 * so a grade typed just before Next, or an answer typed just before Back, was
 * never sent. And two saves in flight at once can land in the wrong order on a
 * slow connection, leaving the older value. So the queue:
 *
 * - sends the latest value once typing pauses (`delayMs`);
 * - sends one at a time, in order, each after the last has answered;
 * - `flush()` sends what is waiting NOW and resolves once everything has been
 *   answered — true only if all of it was stored;
 * - keeps a value whose save failed, so the next `flush()` tries it again,
 *   unless something newer has been typed over it;
 * - `discard()` drops what has not gone yet, for input that must not be sent.
 *
 * Pure, with injectable timers, so the order and the flush can be tested.
 */

export type AutosaveState =
  /** Nothing typed yet, or nothing to say. */
  | { kind: 'idle' }
  /** Typed; the save goes when typing pauses. */
  | { kind: 'waiting' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  /** The last save failed and its value is kept for the next flush. */
  | { kind: 'failed'; error: unknown };

export interface Autosave<T> {
  queue(value: T): void;
  flush(): Promise<boolean>;
  discard(): void;
  /** True while anything typed is not yet stored: waiting, saving or failed. */
  unsaved(): boolean;
}

export function createAutosave<T>(opts: {
  delayMs: number;
  save: (value: T) => Promise<unknown>;
  onState: (state: AutosaveState) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): Autosave<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let pending: { value: T } | null = null;
  let timer: unknown = null;
  let inFlight = 0;
  let lastError: { error: unknown } | null = null;
  let everSaved = false;
  // Every send chains on this, so saves go one at a time and in order.
  let chain: Promise<void> = Promise.resolve();

  const emit = () => {
    opts.onState(
      inFlight > 0
        ? { kind: 'saving' }
        : timer !== null
          ? { kind: 'waiting' }
          : lastError
            ? { kind: 'failed', error: lastError.error }
            : everSaved
              ? { kind: 'saved' }
              : { kind: 'idle' },
    );
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const send = (): Promise<void> => {
    if (!pending) return chain;
    const { value } = pending;
    pending = null;
    inFlight += 1;
    emit();
    chain = chain.then(async () => {
      try {
        await opts.save(value);
        lastError = null;
        everSaved = true;
      } catch (error) {
        lastError = { error };
        // Kept for the next flush — unless newer typing has replaced it.
        if (!pending) pending = { value };
      } finally {
        inFlight -= 1;
        emit();
      }
    });
    return chain;
  };

  return {
    queue(value) {
      stopTimer();
      pending = { value };
      timer = setTimer(() => {
        timer = null;
        void send();
      }, opts.delayMs);
      emit();
    },
    async flush() {
      stopTimer();
      await send();
      return pending === null && lastError === null;
    },
    discard() {
      stopTimer();
      pending = null;
      // A failed value went with it, so there is nothing left to retry.
      lastError = null;
      emit();
    },
    unsaved() {
      return pending !== null || timer !== null || inFlight > 0;
    },
  };
}
