import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/** How fast a title too long for its line slides, and how long it rests at each end. */
const PX_PER_SECOND = 35;
const REST_MS = 1600;

/**
 * A TITLE ON ONE LINE, whatever its length (Faisal, 2026-10-14). One that
 * does not fit slides slowly to its end and back, resting at each end; a tap
 * shows it whole, on as many lines as it needs, and another tap puts it back
 * on its line. With reduced motion on it never slides: it ends in "…", and the
 * tap still shows it whole. The player's title panel took a third of a phone
 * screen for a long session name, above the controls people came for.
 */
export function ScrollingTitle({ text, style, testID }: { text: string; style: StyleProp<TextStyle>; testID?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [still, setStill] = useState(false);
  const [box, setBox] = useState(0);
  const [line, setLine] = useState(0);
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setStill(on));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setStill);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const overflow = Math.max(0, line - box);
  useEffect(() => {
    x.setValue(0);
    if (expanded || still || overflow < 2) return;
    const slide = (toValue: number) =>
      Animated.timing(x, {
        toValue,
        duration: (overflow / PX_PER_SECOND) * 1000,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      });
    const loop = Animated.loop(
      Animated.sequence([Animated.delay(REST_MS), slide(-overflow), Animated.delay(REST_MS), slide(0)]),
    );
    loop.start();
    return () => loop.stop();
  }, [expanded, still, overflow, x]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint={expanded ? 'Shows the title on one line' : 'Shows the whole title'}
      // aria-*, not accessibilityState: react-native-web maps no
      // accessibilityState, so the state reached the DOM as nothing at all.
      aria-expanded={expanded}
      onPress={() => setExpanded((e) => !e)}
    >
      {expanded ? (
        <Text style={style}>{text}</Text>
      ) : still ? (
        <Text style={style} numberOfLines={1}>
          {text}
        </Text>
      ) : (
        <View style={styles.window} onLayout={(e) => setBox(e.nativeEvent.layout.width)}>
          {/* A sideways scroller lets the text take its full single-line width
              — which is what has to be measured — and it is moved, not scrolled. */}
          <ScrollView
            horizontal
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            onContentSizeChange={(w) => setLine(w)}
          >
            <Animated.Text style={[style, { transform: [{ translateX: x }] }]} numberOfLines={1}>
              {text}
            </Animated.Text>
          </ScrollView>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  window: { overflow: 'hidden' },
});
