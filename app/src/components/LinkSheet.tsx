import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { isSafeHref } from '@sabeel/shared';
import { Sheet } from './Sheet';
import { Button, Field } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Adding a link, both surfaces (ported from the Kanban app). Validation is the
 * shared `isSafeHref` the renderer uses, so a link accepted here is never
 * dropped when it is shown.
 */
export function LinkSheet({
  visible,
  initialText,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  /** The selected text, which becomes the link's words. */
  initialText: string;
  onCancel: () => void;
  onConfirm: (href: string, text: string) => void;
}) {
  return (
    <Sheet visible={visible} title="Add a link" onClose={onCancel} closeLabel="Cancel">
      {/* `Sheet` renders nothing while closed, so these mount fresh on each
          open: the mount IS the reseed, and nothing can reach in and empty a
          field mid-typing. */}
      <LinkFields initialText={initialText} onConfirm={onConfirm} />
    </Sheet>
  );
}

function LinkFields({ initialText, onConfirm }: { initialText: string; onConfirm: (href: string, text: string) => void }) {
  const [href, setHref] = useState('');
  const [text, setText] = useState(initialText);
  const trimmed = href.trim();
  const ok = isSafeHref(trimmed);
  return (
    <>
      <Field testID="link-address" label="Address" value={href} onChangeText={setHref} placeholder="https://…" />
      <Field testID="link-text" label="Words to show" value={text} onChangeText={setText} />
      {trimmed && !ok ? <Text style={styles.hint}>A link starts with http://, https:// or mailto:.</Text> : null}
      <Button
        testID="link-add"
        label="Add link"
        disabled={!ok}
        onPress={() => onConfirm(trimmed, text.trim() || trimmed)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: t.text.secondary, marginVertical: spacing(2) },
});
