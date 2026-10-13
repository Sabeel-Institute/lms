import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

/**
 * The conversion the switchover seed applies to every recording it copies from
 * the live app: one audio file becomes Part 1,
 * "Audio only", in REST-encoded Firestore fields.
 *
 * What it promises a person: the recording still plays the same file, for the
 * same length, and a Zoom import is still known to be imported. The transform
 * itself is tested in @sabeel/shared; what is tested here is the encoding
 * either side of it, where a number written as a string or a field left
 * behind would only show up on switchover day.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const mod = (await import(resolve(REPO, 'scripts/lib/legacy-media.mjs'))) as {
  LEGACY_ITEM_ID: string;
  convertRecording: (
    id: string,
    fields: Record<string, unknown>,
  ) => { fields: Record<string, unknown>; claim: { id: string; fields: Record<string, unknown> } | null; legacyFields: string[] };
  isLegacyRecording: (fields: Record<string, unknown>) => boolean;
};

const legacy = {
  sessionId: { stringValue: 's1' },
  courseId: { stringValue: 'c1' },
  title: { stringValue: 'Session 4' },
  status: { stringValue: 'published' },
  source: { stringValue: 'zoom' },
  audioPath: { stringValue: 'recordings/r1/audio.m4a' },
  sizeBytes: { integerValue: '53700000' },
  durationSec: { doubleValue: 3333.5 },
  zoomUuid: { stringValue: 'u==' },
  zoomFileId: { stringValue: 'f1' },
  createdAt: { integerValue: '1700000000000' },
  createdBy: { stringValue: 'adm' },
  publishedAt: { integerValue: '1700000100000' },
};

describe('convertRecording', () => {
  const { fields, claim, legacyFields } = mod.convertRecording('r1', legacy);
  const item = (fields.media as { mapValue: { fields: Record<string, Record<string, unknown>> } }).mapValue.fields[
    mod.LEGACY_ITEM_ID
  ].mapValue as { fields: Record<string, Record<string, unknown>> };

  it('keeps the file where it is, with its size and length as numbers', () => {
    expect(item.fields.storageKey).toEqual({ stringValue: 'recordings/r1/audio.m4a' });
    expect(item.fields.sizeBytes).toEqual({ integerValue: '53700000' });
    expect(item.fields.durationSec).toEqual({ doubleValue: 3333.5 });
    expect(item.fields.status).toEqual({ stringValue: 'ready' });
    expect(item.fields.hidden).toEqual({ booleanValue: false });
    expect(item.fields.part).toEqual({ integerValue: '1' });
    // The recording's own length is untouched, since it is the file's.
    expect(fields.durationSec).toEqual({ doubleValue: 3333.5 });
    expect(fields.defaultVersion).toEqual({ stringValue: 'audio' });
  });

  it('drops the single-file fields and leaves every other field as it was', () => {
    for (const k of ['audioPath', 'sizeBytes', 'zoomUuid', 'zoomFileId']) expect(fields).not.toHaveProperty(k);
    expect(legacyFields.sort()).toEqual(['audioPath', 'sizeBytes', 'zoomFileId', 'zoomUuid']);
    for (const k of ['sessionId', 'courseId', 'title', 'status', 'source', 'createdAt', 'createdBy', 'publishedAt']) {
      expect(fields[k]).toEqual(legacy[k as keyof typeof legacy]);
    }
  });

  it('claims a Zoom file for the recording that holds it', () => {
    expect(claim?.id).toBe('f1');
    expect(claim?.fields).toMatchObject({
      recordingId: { stringValue: 'r1' },
      itemId: { stringValue: mod.LEGACY_ITEM_ID },
      sessionId: { stringValue: 's1' },
      courseId: { stringValue: 'c1' },
      meetingUuid: { stringValue: 'u==' },
    });
  });

  it('gives a recording with no file an empty media map and no claim', () => {
    const none = mod.convertRecording('r2', { ...legacy, audioPath: { nullValue: null } });
    expect(none.fields.media).toEqual({ mapValue: { fields: {} } });
    expect(none.claim).toBeNull();
  });

  it('is recognised as converted afterwards, so a re-run leaves it alone', () => {
    expect(mod.isLegacyRecording(legacy)).toBe(true);
    expect(mod.isLegacyRecording(fields)).toBe(false);
  });
});
