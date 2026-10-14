import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { paragraphDirection } from '@sabeel/shared';

/**
 * Plain text a line at a time, each line running its own way: an Arabic line
 * right to left, an English one left to right, as `RichText` draws its
 * paragraphs. Feedback is plain text, and in one element every line ran the
 * first line's way, so an English line under an Arabic one read
 * ".Good work overall".
 */
export function PlainLines({
  text,
  textStyle,
  style,
  testID,
}: {
  text: string;
  /** Each line's type. */
  textStyle: StyleProp<TextStyle>;
  /** Around them all: spacing from what is above and below. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={style} testID={testID}>
      {text.split('\n').map((line, i) => (
        <Text key={i} style={[textStyle, paragraphDirection(line) === 'rtl' ? styles.rtl : null]}>
          {/* A blank line keeps its height. */}
          {line || ' '}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
