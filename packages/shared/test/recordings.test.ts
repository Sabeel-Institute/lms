import { describe, it, expect } from 'vitest';
import {
  allowedTransitions,
  canPublish,
  canTransition,
  isDiscardable,
  isEmptyDraft,
  isVisibleToStudents,
  listenedFraction,
  listenedShare,
  progressId,
  publishBlockers,
  withSitting,
  type MediaItem,
  type MediaMap,
  type RecordingStatus,
} from '../src';

/** One media item in the given state; everything else as an upload would leave it. */
const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  part: 1,
  version: 'audio',
  kind: 'audio',
  label: null,
  status: 'ready',
  failReason: null,
  hidden: false,
  storageKey: `media/r1/${id}`,
  contentType: 'audio/mp4',
  sizeBytes: 1000,
  durationSec: 3600,
  width: null,
  height: null,
  source: 'upload',
  zoom: null,
  addedAt: 1,
  addedBy: 'adm',
  ...over,
});
const mediaOf = (...items: MediaItem[]): MediaMap => Object.fromEntries(items.map((i) => [i.id, i]));
const AUDIO = mediaOf(item('a1'));
const NONE: MediaMap = {};

const ALL: RecordingStatus[] = [
  'draft',
  'published',
  'archived',
  'unpublished',
  'needsAttention',
];

describe('canTransition', () => {
  it('allows exactly the moves the brief draws', () => {
    const legal = new Set([
      'draft>published',
      'draft>needsAttention',
      'published>archived',
      'published>unpublished',
      'archived>published',
      'unpublished>draft',
      'needsAttention>draft',
    ]);
    for (const from of ALL) {
      for (const to of ALL) {
        expect({ from, to, ok: canTransition(from, to) }).toEqual({
          from,
          to,
          ok: legal.has(`${from}>${to}`),
        });
      }
    }
  });

  it('never allows a state to transition to itself', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });

  it('does NOT let an unpublished recording go straight back to published', () => {
    // It has to pass through draft, so the metadata gate is re-applied. It was
    // withdrawn for a reason, and republishing blind would skip the review.
    expect(canTransition('unpublished', 'published')).toBe(false);
    expect(canTransition('unpublished', 'draft')).toBe(true);
    expect(canTransition('draft', 'published')).toBe(true);
  });

  it('lets an archived recording come straight back', () => {
    // Archiving is filing, not correction — nothing needs re-reviewing.
    expect(canTransition('archived', 'published')).toBe(true);
  });

  it('has no way out of a state except the listed ones', () => {
    expect(allowedTransitions('published')).toEqual(['archived', 'unpublished']);
    expect(allowedTransitions('needsAttention')).toEqual(['draft']);
  });

  it('rejects a status it has never heard of', () => {
    expect(canTransition('nonsense' as RecordingStatus, 'draft')).toBe(false);
    expect(allowedTransitions('nonsense' as RecordingStatus)).toEqual([]);
  });
});

describe('publishBlockers', () => {
  const ready = { media: AUDIO, status: 'draft' as RecordingStatus };

  it('clears a complete draft', () => {
    expect(publishBlockers(ready)).toEqual([]);
    expect(canPublish(ready)).toBe(true);
  });

  it('blocks publishing with nothing a student can play', () => {
    // A published recording with no media is a row in every student's list that
    // plays nothing — the one failure they cannot work around.
    expect(publishBlockers({ ...ready, media: NONE })).toContain('media');
    // Hidden or not yet ready is the same as absent to a student.
    expect(publishBlockers({ ...ready, media: mediaOf(item('a1', { hidden: true })) })).toContain('media');
    expect(publishBlockers({ ...ready, media: mediaOf(item('a1', { status: 'copying' })) })).toContain('media');
  });

  it('blocks publishing while anything is still on its way in, or failed', () => {
    const plus = (other: MediaItem) => ({ ...ready, media: mediaOf(item('a1'), other) });
    expect(publishBlockers(plus(item('v1', { status: 'uploading' })))).toEqual(['pending']);
    expect(publishBlockers(plus(item('v1', { status: 'copying' })))).toEqual(['pending']);
    expect(publishBlockers(plus(item('v1', { status: 'failed', failReason: 'x' })))).toEqual(['failed']);
  });

  it('lets an archived recording go back to published', () => {
    expect(publishBlockers({ ...ready, status: 'archived' })).toEqual([]);
  });

  it('blocks publishing from a state that cannot reach published', () => {
    expect(publishBlockers({ ...ready, status: 'unpublished' })).toContain('status');
    expect(publishBlockers({ ...ready, status: 'needsAttention' })).toContain('status');
    expect(publishBlockers({ ...ready, status: 'published' })).toContain('status');
  });

  it('reports every blocker at once, not just the first', () => {
    // The UI names what is missing; stopping at the first would make fixing them
    // a guessing game one round-trip at a time.
    expect(publishBlockers({ media: NONE, status: 'unpublished' })).toEqual(['media', 'status']);
  });

  it('does not require a due date or notes', () => {
    // Both are optional per the brief; a no-due recording is still required
    // listening, it simply never becomes overdue.
    expect(canPublish(ready)).toBe(true);
  });
});

describe('isEmptyDraft', () => {
  it('is true only when there is no media AND the recording is not live', () => {
    expect(isEmptyDraft({ media: NONE, status: 'draft' })).toBe(true);
    expect(isEmptyDraft({ media: NONE, status: 'needsAttention' })).toBe(true);
  });

  it('is false as soon as any item exists, in any state — that is a real artifact', () => {
    for (const s of ALL) {
      expect(isEmptyDraft({ media: AUDIO, status: s })).toBe(false);
      // A failed Zoom copy is still an item staff must retry or remove.
      expect(isEmptyDraft({ media: mediaOf(item('a1', { status: 'failed' })), status: s })).toBe(false);
    }
  });

  it('is false for any status that has been live, even with no audio', () => {
    // published/archived/unpublished imply students could have listened, so these
    // are never "discard freely" — they keep the admin-only deletion guard.
    for (const s of ['published', 'archived', 'unpublished'] as RecordingStatus[]) {
      expect(isEmptyDraft({ media: NONE, status: s })).toBe(false);
    }
  });

  /*
   * THE CLAIM THIS TEST USED TO MAKE WAS FALSE, and it is worth keeping the
   * correction where the wrong version stood. `isEmptyDraft` is "needs media",
   * not "was never published": no media blocks publishing NOW, and a recording
   * that WAS published can be walked back into exactly this shape
   * (`published → unpublished → draft`, then its media removed) with a term of
   * assignments and completions still pointing at it.
   */
  it('says nothing about what a recording used to be', () => {
    const empty = { media: NONE, status: 'draft' as RecordingStatus };
    expect(isEmptyDraft(empty)).toBe(true);
    expect(publishBlockers(empty)).toContain('media');
    // The same shape, once published: still "needs media", and no longer
    // something anyone may discard.
    const published = { ...empty, publishedAt: 1 };
    expect(isEmptyDraft(published)).toBe(true);
    expect(isDiscardable(published)).toBe(false);
  });
});

/**
 * Which recordings may be thrown away rather than permanently deleted.
 *
 * The distinction the delete gate turns on, and the words the confirmation uses:
 * "Discard … nothing is lost" over a recording with listening history behind it
 * is the confirmation lying, and a manager offered a Discard the server refuses
 * is a button that can only fail.
 */
describe('isDiscardable', () => {
  it('accepts a draft that has never been published', () => {
    expect(isDiscardable({ media: NONE, status: 'draft' })).toBe(true);
    expect(isDiscardable({ media: NONE, status: 'needsAttention' })).toBe(true);
  });

  it('refuses one that was published and walked back', () => {
    expect(isDiscardable({ media: NONE, status: 'draft', publishedAt: 1 })).toBe(false);
  });

  it('refuses one that still holds media, published or not', () => {
    expect(isDiscardable({ media: AUDIO, status: 'draft' })).toBe(false);
  });

  it.each(['published', 'unpublished', 'archived'] as RecordingStatus[])(
    'refuses a %s recording outright',
    (status) => {
      expect(isDiscardable({ media: NONE, status })).toBe(false);
    },
  );
});

describe('isVisibleToStudents', () => {
  it('is true only for published', () => {
    for (const s of ALL) expect(isVisibleToStudents(s)).toBe(s === 'published');
  });
});

describe('withSitting', () => {
  /** The reading device's clock: these saves are all from the last few minutes. */
  const NOW = 1_000;
  const save = (sitting: string, listenedMs: number, updatedAt = NOW) => ({ sitting, listenedMs, updatedAt });

  it('adds up what each sitting played: two devices both count', () => {
    // The laptop listened 10 minutes, the phone 20 more, then the laptop,
    // left open, 5 more: 35, where taking the larger said 30.
    let row = withSitting(null, save('laptop', 600_000), NOW);
    row = withSitting(row, save('phone', 1_200_000), NOW);
    row = withSitting(row, save('laptop', 900_000), NOW);
    expect(row.listenedMs).toBe(2_100_000);
    expect(row.sittings).toEqual({ laptop: 900_000, phone: 1_200_000 });
    expect(row.sitting).toBe('laptop');
  });

  it('counts a save sent twice, or replayed late, once', () => {
    const once = withSitting(null, save('s1', 60_000), NOW);
    expect(withSitting(once, save('s1', 60_000), NOW)).toEqual(once);
    // An older save of the same sitting, arriving after a newer one.
    const later = withSitting(once, save('s1', 90_000), NOW);
    expect(withSitting(later, save('s1', 60_000, NOW - 500), NOW).listenedMs).toBe(90_000);
  });

  it('keeps when it was last listened to, whichever save arrives last', () => {
    const newer = withSitting(null, save('s1', 1, 900), NOW);
    expect(withSitting(newer, save('s2', 1, 400), NOW).updatedAt).toBe(900);
    expect(withSitting(newer, save('s2', 1, 950), NOW).updatedAt).toBe(950);
  });

  /*
   * A CLOCK RUNNING AHEAD. A device a day fast stamped its save a day in the
   * future, and "last listened" stayed in the future until real time caught
   * up, which for a clock set years ahead is never. Stamped past the reader's
   * clock by more than an hour, it gives way; its listening still counts.
   */
  it('a time stamped well past the reader’s clock gives way, and keeps its listening', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const fast = withSitting(null, save('fast', 9_613, NOW + DAY), NOW + DAY);
    const row = withSitting(fast, save('here', 6_000, NOW), NOW);
    expect(row.updatedAt).toBe(NOW);
    expect(row.listenedMs).toBe(15_613);
  });
});

describe('listenedFraction', () => {
  it('is a fraction of the duration', () => {
    expect(listenedFraction(30_000, 60)).toBeCloseTo(0.5);
  });

  it('clamps above 1 — replays must not overflow the bar', () => {
    expect(listenedFraction(500_000, 60)).toBe(1);
  });

  it('returns 0 rather than NaN when duration is unknown', () => {
    // A recording whose duration could not be read still has to render.
    expect(listenedFraction(30_000, null)).toBe(0);
    expect(listenedFraction(30_000, 0)).toBe(0);
  });
});

/*
 * THE LEDGER'S NUMBER, which is read as a fact about the student. A bar can
 * draw an unknown share as empty; a row saying "0% listened" beside "last
 * listened yesterday" is a confident wrong answer on the screen staff use to
 * decide who to chase. Unknown is unknown.
 */
describe('listenedShare', () => {
  it('is the fraction when the length is known', () => {
    expect(listenedShare(30_000, 60)).toBeCloseTo(0.5);
    expect(listenedShare(500_000, 60)).toBe(1);
  });

  it('is unknown, not zero, when the recording has no length', () => {
    expect(listenedShare(30_000, null)).toBeNull();
    expect(listenedShare(30_000, 0)).toBeNull();
  });

  it('is zero for somebody who has not listened, whatever the length', () => {
    expect(listenedShare(0, null)).toBe(0);
    expect(listenedShare(0, 60)).toBe(0);
  });
});

describe('progressId', () => {
  it('is deterministic per student and recording', () => {
    expect(progressId('stu', 'rec')).toBe('stu_rec');
    expect(progressId('stu', 'rec')).not.toBe(progressId('rec', 'stu'));
  });
});
