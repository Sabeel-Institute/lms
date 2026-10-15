import { useEffect, useRef } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { REST_MS, slideEnds, slideMs } from '../titleSlide';

/**
 * The web's slide (native sibling: SlidingText.tsx), RUN BY THE BROWSER.
 *
 * Animated has no native driver on the web: it moved the title from
 * JavaScript on every frame, for as long as the player was open, paused or
 * playing. Measured on a phone-speed CPU that was 10% of the page's main
 * thread with a long title, against 0.9% with a short one, and nearly three
 * times what playing the audio costs it. A web animation of `transform` is
 * run by the compositor, off the main thread, and stops with the page when
 * it is hidden.
 */
export function SlidingText({
  text,
  style,
  overflow,
  rightToLeft,
  moving,
}: {
  text: string;
  style: StyleProp<TextStyle>;
  /** How much wider the line is than its window, in px. */
  overflow: number;
  rightToLeft: boolean;
  moving: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !moving) return;
    const { rest, far } = slideEnds(overflow, rightToLeft);
    const slide = slideMs(overflow);
    const cycle = 2 * (REST_MS + slide);
    const at = (x: number, ms: number): Keyframe => ({ transform: `translateX(${x}px)`, offset: ms / cycle });
    // Rest, slide to the far end, rest, slide back: one cycle, for ever.
    const animation = el.animate(
      [at(rest, 0), at(rest, REST_MS), at(far, REST_MS + slide), at(far, 2 * REST_MS + slide), at(rest, cycle)],
      { duration: cycle, iterations: Infinity, easing: 'linear' },
    );
    return () => animation.cancel();
  }, [moving, overflow, rightToLeft]);
  return (
    <Text ref={ref as never} style={style} numberOfLines={1}>
      {text}
    </Text>
  );
}
