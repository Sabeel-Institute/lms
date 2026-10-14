import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CONFIRM_SECONDS } from '@sabeel/shared';

/*
 * AN UPLOAD IS NOT DELETED WHILE THE SERVER IS CONFIRMING IT. The client used
 * its SDK's default seventy seconds while the server allowed five minutes; a
 * client that gave up first went on to cancel, deleting the file the server was
 * still confirming. What can be held here is the wiring: the client waits past
 * the server's own limit, so the answer it acts on is the server's. A server
 * actually that slow cannot be staged in this suite.
 */
const calls: { name: string; timeout?: number }[] = [];
vi.mock('./firebase', () => ({ db: {}, functions: {} }));
// The live-data hooks the module also exports, and nothing here calls.
vi.mock('./liveQuery', () => ({ useLiveDocState: vi.fn(), useLiveQuery: vi.fn() }));
vi.mock('./documents', () => ({ read: vi.fn() }));
vi.mock('firebase/functions', () => ({
  httpsCallable: (_functions: unknown, name: string, options?: { timeout?: number }) => {
    calls.push({ name, timeout: options?.timeout });
    return async () => ({ data: null });
  },
}));

describe('confirming an upload', () => {
  it('waits past the server’s own limit before giving up', async () => {
    const { uploadApi } = await import('./recordings');
    await uploadApi.finalize({ recordingId: 'r', itemId: 'i', parts: [{ partNumber: 1, etag: 'e' }] });
    const finalize = calls.find((c) => c.name === 'finalizeRecordingUpload');
    expect(finalize?.timeout).toBeGreaterThan(UPLOAD_CONFIRM_SECONDS * 1000);
  });
});
