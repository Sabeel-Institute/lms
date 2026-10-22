import { describe, it, expect, vi, afterEach } from 'vitest';
import { PUSH_CHANNEL_ID, WEB_APP_URL } from '@sabeel/shared';

/**
 * Which sender the module picks, in both directions.
 *
 * This guard is worth pinning because BOTH ways of getting it wrong are silent.
 * Suppressing in production would stop every notification with nothing failing;
 * sending under the emulator puts a live trigger's FCM call in a race with the
 * tests, where whatever the credential-less Admin SDK returns is read as a
 * verdict on real tokens — and a dead-token verdict DELETES the device row the
 * running test is using. That is what made `notify.integration` flaky.
 *
 * The choice is made at module load, so each case re-imports with the
 * environment stubbed rather than calling a setter.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

const MESSAGE = { title: 't', body: 'b', path: 'work/cw1' };

/** A browser's registration: FCM's token, sent through FCM. */
const web = (token: string) => ({ token, platform: 'web' as const, registeredAt: 1 });

async function freshMessaging() {
  vi.resetModules();
  return import('../../src/messaging');
}

describe('sender selection', () => {
  it('suppresses the send under the emulator, pruning nothing', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { send } = await freshMessaging();

    // No FCM call at all: resolves, reports every token delivered so the
    // once-marker stands, and — the part that matters — reports no stale
    // tokens, so no device can be deleted.
    await expect(send([web('tok-a'), web('tok-b')], MESSAGE)).resolves.toEqual({ stale: [], sent: 2 });
    expect(log).toHaveBeenCalled();
  });

  it('uses the REAL sender when the emulator variable is absent', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const { send } = await freshMessaging();

    // There is no initialized Admin app in this process, so the real path throws
    // on getMessaging(). Reaching that throw is the assertion: it proves the
    // production branch was taken. The suppressed sender resolves and could
    // never get here.
    await expect(send([web('tok-a')], MESSAGE)).rejects.toThrow();
  });

  it('treats any value other than the literal "true" as production', async () => {
    // The emulator sets exactly "true". A stray "1" or "false" must not be read
    // as "we are in a test" and quietly disable notifications.
    for (const value of ['1', 'false', 'TRUE']) {
      vi.stubEnv('FUNCTIONS_EMULATOR', value);
      const { send } = await freshMessaging();
      await expect(send([web('tok-a')], MESSAGE)).rejects.toThrow();
    }
  });

  /**
   * The other half of the channel contract (client half: app/src/push.test.ts).
   *
   * A send that names no channel does not fail — Android posts it to FCM's
   * fallback, which it labels "Miscellaneous", and the app's own channel sits
   * there unused. That shipped, and only a real device showed it. Asserting the
   * payload is the only way to catch it without one.
   */
  it('addresses the shared channel, so the push does not land in "Miscellaneous"', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const sendEachForMulticast = vi.fn(async (_message: unknown) => ({
      responses: [] as { success: boolean; error?: { code: string } }[],
      successCount: 0,
    }));
    vi.doMock('firebase-admin/messaging', () => ({
      getMessaging: () => ({ sendEachForMulticast }),
    }));

    const { send } = await freshMessaging();
    await send([web('tok-a')], MESSAGE);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0][0]).toMatchObject({
      android: { notification: { channelId: PUSH_CHANNEL_ID } },
    });
    vi.doUnmock('firebase-admin/messaging');
  });

  /*
   * THE OTHER PLATFORM'S HALF. A web push with no `link` is a banner that
   * closes when tapped and opens nothing: the SDK's click handler in the
   * service worker focuses or opens `fcmOptions.link`, and with none it
   * returns. Every message is about one thing — a recording, an assignment,
   * a register — and the tap has to land on it, not on the home screen.
   */
  it('sends the tap to the thing the message is about, on both surfaces', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const sendEachForMulticast = vi.fn(async (_message: unknown) => ({
      responses: [] as { success: boolean; error?: { code: string } }[],
      successCount: 0,
    }));
    vi.doMock('firebase-admin/messaging', () => ({
      getMessaging: () => ({ sendEachForMulticast }),
    }));

    const { send } = await freshMessaging();
    await send([web('tok-a')], MESSAGE);

    const sent = sendEachForMulticast.mock.calls[0][0] as { data: Record<string, string>; webpush: unknown };
    expect(sent).toMatchObject({ webpush: { fcmOptions: { link: `${WEB_APP_URL}work/cw1` } } });
    // Android reads the path from the data — under any key but `body`, which
    // expo-notifications takes as the whole payload when it parses as JSON.
    expect(sent.data).toEqual({ path: 'work/cw1' });
    vi.doUnmock('firebase-admin/messaging');
  });

  /*
   * WHOSE PHONE GOES SILENT. FCM answers a multicast with one response PER
   * TOKEN, in order, and the only thing tying a failure back to a device is
   * that index — so getting it wrong unregisters a working phone belonging to
   * somebody else, and their notifications stop for good with nothing to see.
   *
   * Nothing drove this loop: the one test that reached the real sender returned
   * an empty `responses` array, so the mapping never executed, and every other
   * suite replaces the sender wholesale.
   */
  it('reports the token whose own send failed, and only that one', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const sendEachForMulticast = vi.fn(async (_message: unknown) => ({
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: true },
      ] as { success: boolean; error?: { code: string } }[],
      successCount: 2,
    }));
    vi.doMock('firebase-admin/messaging', () => ({
      getMessaging: () => ({ sendEachForMulticast }),
    }));

    const { send } = await freshMessaging();
    const out = await send([web('keep-a'), web('dead-b'), web('keep-c')], MESSAGE);

    expect(out.stale).toEqual(['dead-b']);
    expect(out.sent).toBe(2);
    // The tokens reached FCM in the order the responses answer for — the
    // assumption the index mapping rests on.
    expect(sendEachForMulticast.mock.calls[0][0]).toMatchObject({
      tokens: ['keep-a', 'dead-b', 'keep-c'],
    });
    vi.doUnmock('firebase-admin/messaging');
  });

  /*
   * A FAILURE THAT IS NOT THE DEVICE'S FAULT KEEPS THE DEVICE. Deleting on any
   * error would unregister every working phone during an FCM outage, and the
   * only symptom would be notifications quietly stopping.
   */
  it('does not unregister a device over a transient failure', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const sendEachForMulticast = vi.fn(async () => ({
      responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }],
      successCount: 0,
    }));
    vi.doMock('firebase-admin/messaging', () => ({
      getMessaging: () => ({ sendEachForMulticast }),
    }));

    const { send } = await freshMessaging();
    expect((await send([web('still-good')], MESSAGE)).stale).toEqual([]);
    vi.doUnmock('firebase-admin/messaging');
  });

  it('resetSender restores the default rather than re-arming a real send', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { send, setSender, resetSender } = await freshMessaging();

    setSender(async () => ({ stale: ['tok-a'], sent: 0 }));
    await expect(send([web('tok-a')], MESSAGE)).resolves.toEqual({ stale: ['tok-a'], sent: 0 });

    resetSender();
    await expect(send([web('tok-a')], MESSAGE)).resolves.toEqual({ stale: [], sent: 1 });
  });
});

/*
 * TWO SERVICES, ONE NOTIFICATION. An iPhone's token is Apple's and only Apple
 * delivers it; Android and browser tokens are FCM's. What a person is promised
 * is that each of their devices hears, and that one service being down neither
 * silences the other nor makes the retry tell someone twice.
 */
describe('a person with an iPhone', () => {
  const iphone = (token: string) => ({
    token,
    platform: 'ios' as const,
    apnsEnvironment: 'production' as const,
    registeredAt: 1,
  });

  function services(fcm: (message: unknown) => Promise<unknown>, apple: (devices: unknown[]) => Promise<unknown>) {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    vi.stubEnv('APNS_KEY', 'a-key');
    vi.stubEnv('APNS_KEY_ID', 'KEYID12345');
    vi.stubEnv('APPLE_TEAM_ID', 'TEAM123456');
    const sendEachForMulticast = vi.fn(fcm);
    const sendToApns = vi.fn(apple);
    vi.doMock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEachForMulticast }) }));
    vi.doMock('../../src/apns', () => ({ sendToApns }));
    return { sendEachForMulticast, sendToApns };
  }

  afterEach(() => {
    vi.doUnmock('firebase-admin/messaging');
    vi.doUnmock('../../src/apns');
  });

  it('sends the iPhone to Apple and only the rest to FCM', async () => {
    const { sendEachForMulticast, sendToApns } = services(
      async () => ({ responses: [{ success: true }], successCount: 1 }),
      async () => ({ delivered: ['ab12'], dead: [], failed: [] }),
    );
    const { send } = await freshMessaging();
    await expect(send([web('tok-a'), iphone('ab12')], MESSAGE)).resolves.toEqual({ stale: [], sent: 2 });
    expect(sendEachForMulticast.mock.calls[0][0]).toMatchObject({ tokens: ['tok-a'] });
    expect(sendToApns.mock.calls[0][0]).toEqual([{ token: 'ab12', apnsEnvironment: 'production', message: MESSAGE }]);
  });

  it('prunes the iPhone Apple calls dead, and only that one', async () => {
    services(
      async () => ({ responses: [], successCount: 0 }),
      async () => ({ delivered: ['ab12'], dead: ['cd34'], failed: [] }),
    );
    const { send } = await freshMessaging();
    await expect(send([iphone('ab12'), iphone('cd34')], MESSAGE)).resolves.toEqual({ stale: ['cd34'], sent: 1 });
  });

  it('keeps what one service delivered when the other is down: no throw, so no second telling', async () => {
    services(
      async () => {
        throw new Error('FCM unreachable');
      },
      async () => ({ delivered: ['ab12'], dead: [], failed: [] }),
    );
    const { send } = await freshMessaging();
    await expect(send([web('tok-a'), iphone('ab12')], MESSAGE)).resolves.toEqual({ stale: [], sent: 1 });
  });

  it('throws when nothing reached anyone, so the trigger tries again', async () => {
    services(
      async () => {
        throw new Error('FCM unreachable');
      },
      async () => {
        throw new Error('Apple unreachable');
      },
    );
    const { send } = await freshMessaging();
    await expect(send([web('tok-a'), iphone('ab12')], MESSAGE)).rejects.toThrow(/unreachable/);
  });

  /*
   * THE KEY IS BOUND, OR IT IS LOUD. A function that sends but was never given
   * the key reads it as empty; sending on with an empty key would fail at
   * Apple, device by device, as if every iPhone were unreachable.
   */
  it('refuses to send an iPhone anything without the key, and says why', async () => {
    const { sendToApns } = services(
      async () => ({ responses: [], successCount: 0 }),
      async () => ({ delivered: [], dead: [], failed: [] }),
    );
    vi.stubEnv('APNS_KEY', '');
    const { send } = await freshMessaging();
    await expect(send([iphone('ab12')], MESSAGE)).rejects.toThrow(/APNS_KEY is not bound/);
    expect(sendToApns).not.toHaveBeenCalled();
  });

  it('does not need the key for a person with no iPhone', async () => {
    services(
      async () => ({ responses: [{ success: true }], successCount: 1 }),
      async () => {
        throw new Error('Apple must not be called');
      },
    );
    vi.stubEnv('APNS_KEY', '');
    const { send } = await freshMessaging();
    await expect(send([web('tok-a')], MESSAGE)).resolves.toEqual({ stale: [], sent: 1 });
  });
});
