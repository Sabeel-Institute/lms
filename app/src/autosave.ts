/**
 * Save-as-you-type, made safe to leave.
 *
 * A debounce on its own loses work: the timer is cleared when the screen goes,
 * so a grade typed just before Next, or an answer typed just before Back, was
 * never sent. And two saves in flight at once can land in the wrong order on a
 * slow connection, leaving the older value. So the queue:
 *
 * - sends the latest value once typing pauses (`delayMs`), and, with
 *   `maxWaitMs`, at least that often while typing never pauses: each
 *   keystroke restarted the timer, so ten seconds of steady typing reached
 *   nothing, and a reload in them lost all of it;
 * - sends one at a time, in order, each after the last has answered;
 * - `flush()` sends what is waiting NOW and resolves once everything has been
 *   answered — true only if all of it was stored — or, given a time, false
 *   once that runs out;
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
  /**
   * Send what waits and resolve once everything has answered: true if it was
   * all stored. Given `withinMs`, false once that runs out, with the save
   * still on its way: offline a write never answers until the connection is
   * back, and a person waiting on it was left with a spinner.
   */
  flush(withinMs?: number): Promise<boolean>;
  discard(): void;
  /** True while anything typed is not yet stored: waiting, saving or failed. */
  unsaved(): boolean;
}

/**
 * Every autosave holding something not yet sent, so Sign out can send it
 * first: an answer's last words waited out their delay after the account had
 * signed out, were refused, and existed only in that browser.
 */
const unsent = new Set<{ flush(): Promise<boolean> }>();

/** Send whatever every autosave is holding. Sign out waits for the writes it starts. */
export function flushEveryAutosave(): Promise<unknown> {
  return Promise.all([...unsent].map((a) => a.flush()));
}

export function createAutosave<T>(opts: {
  delayMs: number;
  /** The longest a value may wait while typing goes on without a pause. */
  maxWaitMs?: number;
  save: (value: T) => Promise<unknown>;
  onState: (state: AutosaveState) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
}): Autosave<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = opts.now ?? Date.now;
  /** When the oldest value not yet sent was typed; null when nothing waits. */
  let waitingSince: number | null = null;

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
        if (!pending && timer === null && inFlight === 0) unsent.delete(self);
        emit();
      }
    });
    return chain;
  };

  const self: Autosave<T> = {
    queue(value) {
      unsent.add(self);
      stopTimer();
      pending = { value };
      const at = now();
      if (waitingSince === null) waitingSince = at;
      const delay =
        opts.maxWaitMs === undefined ? opts.delayMs : Math.min(opts.delayMs, Math.max(0, waitingSince + opts.maxWaitMs - at));
      timer = setTimer(() => {
        timer = null;
        waitingSince = null;
        void send();
      }, delay);
      emit();
    },
    flush(withinMs) {
      stopTimer();
      waitingSince = null;
      const stored = send().then(() => pending === null && lastError === null);
      if (withinMs === undefined) return stored;
      return new Promise<boolean>((resolve) => {
        const limit = setTimer(() => resolve(false), withinMs);
        void stored.then((ok) => {
          clearTimer(limit);
          resolve(ok);
        });
      });
    },
    discard() {
      unsent.delete(self);
      stopTimer();
      waitingSince = null;
      pending = null;
      // A failed value went with it, so there is nothing left to retry.
      lastError = null;
      emit();
    },
    unsaved() {
      return pending !== null || timer !== null || inFlight > 0;
    },
  };
  return self;
}
