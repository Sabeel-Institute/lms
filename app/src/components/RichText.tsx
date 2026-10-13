import { Fragment } from 'react';
import { Linking, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { paragraphDirection, parseRichForDisplay, type RichInline } from '@sabeel/shared';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Renders an assignment's instructions on both platforms (ported from the
 * institute's Kanban app). All parsing is in `@sabeel/shared/richtext`; this
 * maps typed nodes to `Text`, so instructions containing `<script>` render as
 * literal characters and there is no sanitiser to get wrong.
 *
 * EACH PARAGRAPH RUNS ITS OWN WAY: Arabic right to left, English left to
 * right, from its first strong character — a hikma and the line explaining it
 * sit one under the other in the same instructions.
 */
function openHref(href: string) {
  void Linking.openURL(href).catch(() => undefined);
}

function Inline({ nodes }: { nodes: RichInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text':
            return <Fragment key={i}>{n.text}</Fragment>;
          case 'bold':
            return (
              <Text key={i} style={styles.bold}>
                <Inline nodes={n.content} />
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} style={styles.italic}>
                <Inline nodes={n.content} />
              </Text>
            );
          case 'link':
            return (
              <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => openHref(n.href)}>
                <Inline nodes={n.content} />
              </Text>
            );
        }
      })}
    </>
  );
}

/** Right-to-left text, aligned to the right, where its first strong character says so. */
function direction(nodes: RichInline[]): TextStyle | null {
  return paragraphDirection(plain(nodes)) === 'rtl' ? styles.rtl : null;
}

function plain(nodes: RichInline[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.text : plain(n.content))).join('');
}

/** A list row: the marker in its own column, so wrapped text stays aligned. */
function Item({ marker, nodes }: { marker: string; nodes: RichInline[] }) {
  const rtl = direction(nodes) !== null;
  return (
    <View style={[styles.row, rtl ? styles.rowRtl : null]}>
      <Text style={[styles.body, styles.marker]}>{marker}</Text>
      <Text style={[styles.body, styles.rowText, rtl ? styles.rtl : null]}>
        <Inline nodes={nodes} />
      </Text>
    </View>
  );
}

export function RichText({ markdown }: { markdown: string }) {
  const doc = parseRichForDisplay(markdown);
  return (
    <View style={styles.doc}>
      {doc.map((b, i) =>
        b.kind === 'paragraph' ? (
          <Text key={i} selectable style={[styles.body, direction(b.content)]}>
            <Inline nodes={b.content} />
          </Text>
        ) : (
          <View key={i} style={styles.list}>
            {b.items.map((item, j) => (
              <Item key={j} marker={b.kind === 'bullets' ? '•' : `${j + 1}.`} nodes={item} />
            ))}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  doc: { gap: spacing(2) },
  list: { gap: spacing(1) },
  body: { fontSize: 15, lineHeight: 22, color: t.text.primary },
  row: { flexDirection: 'row', gap: spacing(2) },
  rowRtl: { flexDirection: 'row-reverse' },
  // A fixed column keeps "10." from shoving its text out of line with "9.".
  marker: { minWidth: 18, textAlign: 'right', color: t.text.secondary },
  rowText: { flex: 1 },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline', color: t.accent.base },
});
