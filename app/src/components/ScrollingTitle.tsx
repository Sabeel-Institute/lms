import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { readsRightToLeft } from '../titleSlide';
import { SlidingText } from './SlidingText';

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
            <SlidingText
              text={text}
              style={style}
              overflow={overflow}
              rightToLeft={readsRightToLeft(text)}
              moving={overflow >= 2}
            />
          </ScrollView>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  window: { overflow: 'hidden' },
});
