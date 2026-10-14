import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { formatClock } from '../playback';
import { getTheme } from '../theme';

const t = getTheme();

/**
 * Web scrubber (native sibling: Scrubber.tsx uses @react-native-community/slider,
 * which has no web build).
 *
 * A hand-rolled PanResponder bar. On web the pointer maps cleanly to a mouse and
 * there is no native ScrollView fighting for the gesture — the exact problem that
 * sank this approach on device — so a plain pan is reliable here. While dragging,
 * the bar shows the finger's position and previews it via `onScrub`; the seek is
 * committed once, on release.
 */
export function Scrubber({
  positionMs,
  durationMs,
  disabled,
  onSeek,
  onScrub,
  testID,
}: {
  positionMs: number;
  durationMs: number;
  disabled?: boolean;
  onSeek: (ms: number) => void;
  onScrub?: (ms: number | null) => void;
  testID?: string;
}) {
  const [width, setWidth] = useState(0);
  const [dragFraction, setDragFraction] = useState<number | null>(null);

  const widthRef = useRef(0);
  const durationRef = useRef(durationMs);
  const disabledRef = useRef(disabled);
  const onScrubRef = useRef(onScrub);
  const grantXRef = useRef(0);
  widthRef.current = width;
  durationRef.current = durationMs;
  disabledRef.current = disabled;
  onScrubRef.current = onScrub;

  const responder = useMemo(() => {
    const drag = (fraction: number) => {
      setDragFraction(fraction);
      onScrubRef.current?.(durationRef.current > 0 ? Math.round(fraction * durationRef.current) : 0);
    };
    const end = () => {
      setDragFraction(null);
      onScrubRef.current?.(null);
    };
    const active = () => !disabledRef.current && widthRef.current > 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: active,
      onMoveShouldSetPanResponder: active,
      onPanResponderGrant: (e) => {
        grantXRef.current = e.nativeEvent.locationX ?? 0;
        drag(clamp(grantXRef.current / widthRef.current));
      },
      onPanResponderMove: (_e, gesture) => {
        drag(clamp((grantXRef.current + gesture.dx) / widthRef.current));
      },
      onPanResponderRelease: (_e, gesture) => {
        const f = clamp((grantXRef.current + gesture.dx) / widthRef.current);
        end();
        if (durationRef.current > 0) onSeek(Math.round(f * durationRef.current));
      },
      onPanResponderTerminate: end,
    });
  }, [onSeek]);

  /*
   * BY KEYBOARD TOO: a slider a pointer can drag and nothing else can reach
   * shut out anyone at a keyboard or a screen reader, and announced no
   * position. Arrows move five seconds, Page Up and Down a minute, Home and
   * End to either end; a key goes straight to a seek, as a release does.
   */
  const host = useRef<View>(null);
  const keyState = useRef({ positionMs, durationMs, disabled, onSeek });
  keyState.current = { positionMs, durationMs, disabled, onSeek };
  useEffect(() => {
    const el = host.current as unknown as HTMLElement | null;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      if (k.disabled || k.durationMs <= 0) return;
      const target =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? k.durationMs
            : k.positionMs + (KEY_MOVES[e.key] ?? NaN);
      if (Number.isNaN(target)) return;
      e.preventDefault();
      k.onSeek(Math.max(0, Math.min(k.durationMs, target)));
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const playedFraction = dragFraction ?? (durationMs > 0 ? clamp(positionMs / durationMs) : 0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View
      ref={host}
      testID={testID}
      role="slider"
      focusable={!disabled}
      aria-label="Playback position"
      aria-disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={Math.round(positionMs / 1000)}
      aria-valuetext={`${formatClock(positionMs)} of ${formatClock(durationMs)}`}
      onLayout={onLayout}
      style={styles.hit}
      {...responder.panHandlers}
    >
      <View style={styles.track}>
        <View style={[styles.played, { width: `${playedFraction * 100}%` }]} />
      </View>
      <View
        style={[
          styles.thumb,
          dragFraction !== null ? styles.thumbActive : null,
          { left: `${playedFraction * 100}%` },
          disabled ? styles.thumbDisabled : null,
        ]}
      />
    </View>
  );
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** How far a key moves the place, in milliseconds. */
const KEY_MOVES: Record<string, number> = {
  ArrowRight: 5_000,
  ArrowUp: 5_000,
  ArrowLeft: -5_000,
  ArrowDown: -5_000,
  PageUp: 60_000,
  PageDown: -60_000,
};

const THUMB = 16;

const styles = StyleSheet.create({
  hit: { paddingVertical: 14, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: t.bg.inset, overflow: 'hidden' },
  played: { height: 6, backgroundColor: t.accent.base },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: t.accent.base,
    marginLeft: -THUMB / 2,
  },
  thumbActive: { transform: [{ scale: 1.4 }] },
  thumbDisabled: { backgroundColor: t.border.strong },
});
