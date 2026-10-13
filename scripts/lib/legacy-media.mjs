/**
 * A recording stored before parts existed, converted to media items — on
 * Firestore REST documents, which is how the switchover seed copies them from
 * the live app.
 *
 * The conversion itself is `mediaFromSingleAudio` in @sabeel/shared; this file
 * only moves values between the REST encoding and plain JavaScript. The same
 * function converted this project's own copy in place on 2026-10-12, before
 * the seed learned to convert, so both hold the same shape.
 */
import { COLLECTIONS, mediaFromSingleAudio } from '@sabeel/shared';

/** The item id a converted recording's one file gets. Deterministic, so a
 *  re-run converts to the same document. */
const LEGACY_ITEM_ID = 'audio1';

/** The fields that held the one file before parts existed. */
const LEGACY_FIELDS = ['audioPath', 'sizeBytes', 'zoomUuid', 'zoomFileId'];

function fromValue(v) {
  if (!v || 'nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  throw new Error(`unexpected value in a recording: ${JSON.stringify(v)}`);
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
  }
  throw new Error(`cannot encode ${typeof v}`);
}

/** Whether a REST recording document is still in the single-file shape. */
export const isLegacyRecording = (fields) => !('media' in fields);

/**
 * The converted fields of one recording, and the Zoom claim its file needs.
 *
 * `fields` is the document's REST `fields`. Returns the new `fields` (legacy
 * keys removed, `media` and `defaultVersion` added, `durationSec` kept) and,
 * for a Zoom import with a file id, the `zoomImports/{fileId}` document's REST
 * `fields` — without it the picker would offer the file for import again.
 */
export function convertRecording(recordingId, fields) {
  const get = (k) => fromValue(fields[k]);
  const media = mediaFromSingleAudio(
    {
      source: get('source') === 'zoom' ? 'zoom' : 'manual',
      audioPath: get('audioPath'),
      sizeBytes: get('sizeBytes'),
      durationSec: get('durationSec'),
      zoomUuid: get('zoomUuid') ?? undefined,
      zoomFileId: get('zoomFileId') ?? undefined,
      createdAt: get('createdAt') ?? 0,
      createdBy: get('createdBy') ?? '',
    },
    LEGACY_ITEM_ID,
  );
  const out = Object.fromEntries(Object.entries(fields).filter(([k]) => !LEGACY_FIELDS.includes(k)));
  out.media = toValue(media);
  out.defaultVersion = toValue('audio');
  // The derived length is the file's own, so `durationSec` carries over as is.
  const item = media[LEGACY_ITEM_ID];
  const claim = item?.zoom
    ? {
        id: item.zoom.fileId,
        fields: toValue({
          recordingId,
          itemId: LEGACY_ITEM_ID,
          sessionId: get('sessionId'),
          courseId: get('courseId'),
          meetingUuid: item.zoom.meetingUuid,
          claimedAt: get('createdAt') ?? 0,
        }).mapValue.fields,
      }
    : null;
  return { fields: out, claim, legacyFields: LEGACY_FIELDS.filter((k) => k in fields) };
}

export const ZOOM_IMPORTS = COLLECTIONS.zoomImports;
