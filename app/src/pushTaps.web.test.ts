import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The open tab's end of a tapped web notification (`pushTaps.web.ts`).
 *
 * The service worker posts an open tab `{ type: 'push-open', data: { path } }`
 * (functions/test/unit/firebaseMessagingSw.test.ts holds that side). Each must
 * reach the shell's opener once, including one that arrived while the tab was
 * still on sign-in, before the shell subscribed.
 */
type MessageListener = (event: { data: unknown }) => void;

async function load() {
  vi.resetModules();
  let onMessage: MessageListener | undefined;
  vi.stubGlobal('navigator', {
    serviceWorker: {
      addEventListener: (type: string, fn: MessageListener) => {
        if (type === 'message') onMessage = fn;
      },
    },
  });
  const mod = await import('./pushTaps.web');
  return { ...mod, post: (data: unknown) => onMessage!({ data }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('a tab already open when the notification is tapped', () => {
  it('hands each tap to the opener, and holds one that came before anyone subscribed', async () => {
    const m = await load();
    m.post({ type: 'push-open', data: { path: 'work/cw1' } });
    const seen: string[] = [];
    const unsubscribe = m.onPushTap((path) => seen.push(path));
    m.post({ type: 'push-open', data: { path: 'play/r1' } });
    expect(seen).toEqual(['work/cw1', 'play/r1']);
    unsubscribe();
    m.post({ type: 'push-open', data: { path: 'courses/c1/sessions/s1' } });
    expect(seen).toHaveLength(2);
  });

  it('opens a held tap once, not again for the next subscriber', async () => {
    const m = await load();
    m.post({ type: 'push-open', data: { path: 'work/cw1' } });
    const first: string[] = [];
    const second: string[] = [];
    m.onPushTap((path) => first.push(path))();
    m.onPushTap((path) => second.push(path));
    expect(first).toEqual(['work/cw1']);
    expect(second).toEqual([]);
  });

  it('ignores any other message from the worker', async () => {
    const m = await load();
    const seen: string[] = [];
    m.onPushTap((path) => seen.push(path));
    m.post({ type: 'open-path', path: 'work/cw1' });
    m.post(null);
    m.post({ type: 'push-open', data: { path: '' } });
    m.post({ type: 'push-open', data: 'work/cw1' });
    expect(seen).toEqual([]);
  });
});
