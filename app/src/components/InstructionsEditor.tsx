import { StyleSheet, Text, View } from 'react-native';
import { LazyRichEditor } from './LazyRichEditor';
import { inputLook } from './ui';
import { spacing } from '../theme';

/**
 * Where a teacher writes an assignment's instructions: bold, italic, two
 * kinds of list and links, the Kanban app's editor. Stored as markdown in the
 * five-element vocabulary of `@sabeel/shared/richtext` and shown by
 * `RichText`, which works each paragraph's direction out from its words.
 *
 * `value` seeds the editor once; after that the editor owns the text.
 */
export function InstructionsEditor({ value, onChange }: { value: string; onChange: (markdown: string) => void }) {
  return (
    <View style={styles.field}>
      <Text style={inputLook.label}>Instructions</Text>
      <LazyRichEditor
        testID="coursework-instructions"
        label="Instructions"
        placeholder="What to do, and what to hand in"
        initialMarkdown={value}
        onChangeMarkdown={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginTop: spacing(3) },
});
