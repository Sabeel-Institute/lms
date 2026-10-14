import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type AutosaveState } from './autosave';

/**
 * The promises a teacher grading and a student writing are given: what they
 * typed is stored even if they leave at once, in the order they typed it, and
 * a save that failed is not quietly forgotten.
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A server that answers when told, recording what reached it and in what order. */
function slowServer() {
  const calls: { value: string; answer: ReturnType<typeof deferred> }[] = [];
  const stored: string[] = [];
  return {
    calls,
    stored,
    save: (value: string) => {
      const answer = deferred();
      calls.push({ value, answer });
      return answer.promise.then(() => {
        stored.push(value);
      });
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('autosave', () => {
  let states: AutosaveState['kind'][];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    states = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (save: (v: string) => Promise<unknown>) =>
    createAutosave<string>({ delayMs: 600, save, onState: (s) => states.push(s.kind) });

  it('sends the latest value once typing pauses, and only that', async () => {
    const saved: string[] = [];
    const a = make(async (v) => void saved.push(v));
    a.queue('8');
    a.queue('9');
    vi.advanceTimersByTime(599);
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(saved).toEqual(['9']);
    expect(states.at(-1)).toBe('saved');
  });

  it('STEADY TYPING IS STILL SENT: with a maximum wait, a value goes even while keys keep coming', async () => {
    const saved: string[] = [];
    let clock = 0;
    const a = createAutosave<string>({
      delayMs: 700,
      maxWaitMs: 2500,
      save: async (v) => void saved.push(v),
      onState: () => {},
      now: () => clock,
    });
    // A key every 200 ms for five seconds: never a 700 ms pause.
    for (let i = 1; i <= 25; i += 1) {
      a.queue(`typed ${i}`);
      clock += 200;
      vi.advanceTimersByTime(200);
      await tick();
    }
    // Sent at the 2.5 s mark, mid-typing, with what was on the screen then.
    expect(saved).toEqual(['typed 13']);
    // And the last of it once the typing pauses.
    vi.advanceTimersByTime(700);
    await tick();
    expect(saved).toEqual(['typed 13', 'typed 25']);
  });

  it('LEAVING AT ONCE STILL STORES IT: flush sends what is waiting, without the timer', async () => {
    const saved: string[] = [];
    const a = make(async (v) => void saved.push(v));
    a.queue('9');
    expect(a.unsaved()).toBe(true);
    await expect(a.flush()).resolves.toBe(true);
    expect(saved).toEqual(['9']);
    expect(a.unsaved()).toBe(false);
    // The timer that was waiting must not send it a second time.
    vi.advanceTimersByTime(1000);
    await tick();
    expect(saved).toEqual(['9']);
  });

  it('IN THE ORDER TYPED: a second save waits for the first to answer', async () => {
    const server = slowServer();
    const a = make(server.save);
    a.queue('8');
    vi.advanceTimersByTime(600);
    a.queue('9');
    vi.advanceTimersByTime(600);
    await tick();
    // Only the first has gone; the second waits behind it.
    expect(server.calls.map((c) => c.value)).toEqual(['8']);
    server.calls[0].answer.resolve();
    await tick();
    await tick();
    expect(server.calls.map((c) => c.value)).toEqual(['8', '9']);
    server.calls[1].answer.resolve();
    await tick();
    expect(server.stored).toEqual(['8', '9']);
  });

  it('flush waits for a save already on its way', async () => {
    const server = slowServer();
    const a = make(server.save);
    a.queue('9');
    vi.advanceTimersByTime(600);
    let done = false;
    const flushed = a.flush().then((ok) => {
      done = ok;
    });
    await tick();
    expect(done).toBe(false);
    server.calls[0].answer.resolve();
    await flushed;
    expect(done).toBe(true);
  });

  it('A FAILED SAVE IS KEPT: it shows as failed, and the next flush tries it again', async () => {
    let fail = true;
    const saved: string[] = [];
    const a = make(async (v) => {
      if (fail) throw new Error('offline');
      saved.push(v);
    });
    a.queue('9');
    await expect(a.flush()).resolves.toBe(false);
    expect(states.at(-1)).toBe('failed');
    expect(a.unsaved()).toBe(true);
    fail = false;
    await expect(a.flush()).resolves.toBe(true);
    expect(saved).toEqual(['9']);
    expect(a.unsaved()).toBe(false);
  });

  it('newer typing replaces a failed value rather than resending the old one', async () => {
    let fail = true;
    const saved: string[] = [];
    const a = make(async (v) => {
      if (fail) throw new Error('offline');
      saved.push(v);
    });
    a.queue('8');
    await a.flush();
    fail = false;
    a.queue('9');
    await a.flush();
    expect(saved).toEqual(['9']);
  });

  it('discard drops what has not gone, so input that must not be sent is not', async () => {
    const saved: string[] = [];
    const a = make(async (v) => void saved.push(v));
    a.queue('9');
    a.discard();
    vi.advanceTimersByTime(1000);
    await tick();
    expect(saved).toEqual([]);
    await expect(a.flush()).resolves.toBe(true);
    expect(saved).toEqual([]);
  });
});
