import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useClip } from '../clip';
import { PLAYBACK_RATES, formatClock } from '../playback';
import { PlayPauseGlyph } from './Transport';
import { Scrubber } from './Scrubber';
import { Button } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * An attached audio file, played in place: a recitation handed in, or a
 * teacher's example. Play, the place in it, the time and the speed, drawn the
 * same on the phone and in the browser. A small player of its own, not the
 * class player, which belongs to recordings and their progress; starting it
 * pauses a class recording, and the other way round (oneSound.ts).
 *
 * NOT THE PLATFORM'S CONTROLS. Android's, at the height of a row, fold to play
 * and full screen — no place, no time, no speed — and a teacher's example can
 * run to fifteen minutes.
 *
 * `durationMs` is the length measured when the file arrived, so the time reads
 * in full before anything has loaded, the same figure as the line above it.
 */
export function AttachmentAudio({
  url,
  attempt,
  name,
  durationMs,
  onRetry,
}: {
  url: string;
  /** Counts "Try again": each one loads afresh, whether or not the link changed. */
  attempt: number;
  name: string;
  durationMs: number;
  /** Fetch a new link and play from the same place; links last an hour. */
  onRetry: () => void;
}) {
  const clip = useClip(url, attempt);
  // The finger's place while dragging, so the time follows it before the seek.
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? Math.min(clip.positionMs, durationMs);

  if (clip.status === 'failed') {
    return (
      <View testID={`clip-failed-${name}`} style={styles.failed}>
        <Text style={styles.failedText}>The audio stopped loading.</Text>
        <Button testID={`clip-retry-${name}`} label="Try again" variant="secondary" hug onPress={onRetry} />
      </View>
    );
  }

  const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(clip.rate as (typeof PLAYBACK_RATES)[number]) + 1) % PLAYBACK_RATES.length];
  return (
    <View testID={`clip-${name}`} style={styles.clip}>
      <Pressable
        testID={`clip-play-${name}`}
        accessibilityRole="button"
        accessibilityLabel={`${clip.playing ? 'Pause' : 'Play'} ${name}`}
        onPress={clip.toggle}
        style={({ pressed }) => [styles.play, pressed ? styles.pressed : null]}
      >
        {/* 0.62: the docked bar's 44px button, the same glyph at the same size. */}
        <PlayPauseGlyph playing={clip.playing} scale={0.62} />
      </Pressable>
      <View style={styles.track}>
        <Scrubber
          testID={`clip-seek-${name}`}
          positionMs={shown}
          durationMs={durationMs}
          disabled={clip.status !== 'ready'}
          onScrub={setScrub}
          onSeek={clip.seek}
        />
        <View style={styles.under}>
          <Text testID={`clip-time-${name}`} style={styles.time}>
            {formatClock(shown)} / {formatClock(durationMs)}
          </Text>
          <Pressable
            testID={`clip-speed-${name}`}
            accessibilityRole="button"
            accessibilityLabel={`Speed ${clip.rate}×. Change to ${next}×`}
            onPress={() => clip.setRate(next)}
            style={({ pressed }) => [styles.speed, pressed ? styles.pressed : null]}
          >
            <Text style={styles.speedText}>{clip.rate}×</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    // 12, not 8: the scrubber reaches 8px past its track (Scrubber.tsx), and
    // at 8 it would touch the play button.
    gap: spacing(3),
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(2),
    marginVertical: spacing(1),
    borderWidth: 1,
    borderColor: t.border.subtle,
    borderRadius: 8,
    backgroundColor: t.bg.surface,
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.accent.base,
  },
  pressed: { opacity: 0.85 },
  // A ZERO-BASIS GROWER that may shrink: Yoga will not shrink a child unless it
  // is told to, and the scrubber's track must give way to the play button.
  track: { flex: 1, minWidth: 0 },
  under: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  time: { fontSize: 13, color: t.text.secondary, fontVariant: ['tabular-nums'] },
  speed: {
    minWidth: 52,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedText: {
    fontSize: 14,
    fontWeight: '700',
    color: t.text.accent,
    borderWidth: 1,
    borderColor: t.border.strong,
    borderRadius: 14,
    overflow: 'hidden',
    paddingHorizontal: spacing(2),
    paddingVertical: 2,
  },
  failed: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing(2),
    marginVertical: spacing(1),
  },
  failedText: { fontSize: 14, color: t.text.secondary },
});
