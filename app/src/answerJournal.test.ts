import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ captureError: vi.fn() }));
const device = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => device.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      device.set(k, v);
    },
    removeItem: async (k: string) => {
      device.delete(k);
    },
  },
}));

const { forgetAnswer, journalAnswer, journaledAnswer, restorable } = await import('./answerJournal');
const flush = () => new Promise((r) => setTimeout(r, 0));

/*
 * AN ANSWER TYPED WITH NO SIGNAL, ON ANDROID, lived only in memory until the
 * connection came back; an app killed first took it. The device keeps a copy
 * until the server holds it, and puts it back when the work is opened again.
 */
describe('the answer kept on the device', () => {
  beforeEach(() => device.clear());

  it('is kept as typed, and forgotten once the server holds exactly it', async () => {
    journalAnswer('u', 'cw', 'My answer');
    await flush();
    expect((await journaledAnswer('u', 'cw'))?.note).toBe('My answer');
    await forgetAnswer('u', 'cw', 'My answer');
    expect(await journaledAnswer('u', 'cw')).toBeNull();
  });

  it('keeps newer typing when an older text is the one saved', async () => {
    journalAnswer('u', 'cw', 'My answer, and more');
    await flush();
    await forgetAnswer('u', 'cw', 'My answer');
    expect((await journaledAnswer('u', 'cw'))?.note).toBe('My answer, and more');
  });

  it('is put back over an older stored answer, never over a newer one or the same words', () => {
    const entry = { note: 'Typed offline', at: 2_000 };
    expect(restorable(entry, { note: 'Before', updatedAt: 1_000 })).toBe(true);
    expect(restorable(entry, null)).toBe(true);
    // Another device wrote since: the server's is the one to keep.
    expect(restorable(entry, { note: 'From the laptop', updatedAt: 3_000 })).toBe(false);
    expect(restorable(entry, { note: 'Typed offline', updatedAt: 1_000 })).toBe(false);
    expect(restorable({ note: '  ', at: 2_000 }, null)).toBe(false);
  });
});
