import { useEffect, useRef } from 'react';
import { Animated, Easing, type StyleProp, type TextStyle } from 'react-native';
import { REST_MS, slideEnds, slideMs } from '../titleSlide';

/**
 * One line of text sliding to its far end and back, resting at each end
 * (`ScrollingTitle`). Native: Animated on the native driver, so no frame of
 * it runs JavaScript. The web's sibling hands the slide to the browser.
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
  const { rest, far } = slideEnds(overflow, rightToLeft);
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    x.setValue(moving ? rest : 0);
    if (!moving) return;
    const slide = (toValue: number) =>
      Animated.timing(x, { toValue, duration: slideMs(overflow), easing: Easing.linear, useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([Animated.delay(REST_MS), slide(far), Animated.delay(REST_MS), slide(rest)]));
    loop.start();
    return () => loop.stop();
  }, [moving, overflow, rest, far, x]);
  return (
    <Animated.Text style={[style, { transform: [{ translateX: x }] }]} numberOfLines={1}>
      {text}
    </Animated.Text>
  );
}
