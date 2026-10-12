import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CONTENT_MAX_WIDTH, getTheme, spacing, useTheme } from '../theme';
import { APP_NAME } from '@sabeel/shared';

const t = getTheme();

/**
 * Every semantic theme token, rendered. Reachable from the More menu, in dev builds only.
 *
 * It exists because the palette being *right* is the part that survives a code
 * review of the hex values and then looks wrong on a phone. Screenshot it on
 * both surfaces and read it against docs/BRAND.md.
 *
 * Note what this screen deliberately is NOT: there is no raspberry app bar.
 * Chrome is ivory with a dark title — a brand-coloured bar repeated on every
 * screen pushes raspberry far past its ~20% share. Raspberry appears here only
 * on the one specimen card that exists to show text on an accent fill.
 */

/** A colour chip. The swatch carries the colour; the label never does — a
 *  label tinted with its own swatch is unreadable the moment the swatch is
 *  light (true gold lands at ~2.1:1 on ivory). */
function Swatch({ name, value, note }: { name: string; value: string; note?: string }) {
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.chip, { backgroundColor: value }]} />
      <View style={styles.swatchText}>
        <Text style={styles.swatchName}>{name}</Text>
        {note ? <Text style={styles.swatchNote}>{note}</Text> : null}
      </View>
      <Text style={styles.swatchValue}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // useTheme() is the API screens should reach for; getTheme() exists only for
  // module-scope StyleSheet.create, which cannot call a hook.
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.text.secondary }]}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export function TokensScreen() {
  return (
    <ScrollView
      testID="tokens-sheet"
      style={styles.canvas}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.h1}>{APP_NAME}</Text>
      <Text style={styles.lede}>
        Design tokens — Sabeel Institute, Option 1 palette. Single light theme.
      </Text>

      <Section title="Backgrounds">
        <Swatch name="bg.canvas" value={t.bg.canvas} note="app background" />
        <Swatch name="bg.surface" value={t.bg.surface} note="cards, rows" />
        <Swatch name="bg.raised" value={t.bg.raised} note="menus" />
        <Swatch name="bg.inset" value={t.bg.inset} note="inputs" />
        <Swatch name="bg.accentSoft" value={t.bg.accentSoft} note="selected item" />
        <Swatch name="bg.sage" value={t.bg.sage} note="secondary buttons, chips" />
        <Swatch name="bg.goldSoft" value={t.bg.goldSoft} note="pending row" />
        <Swatch name="bg.dangerSoft" value={t.bg.dangerSoft} note="destructive confirm" />
      </Section>

      <Section title="Text on ivory">
        <Text style={[styles.specimen, { color: t.text.primary }]}>
          text.primary — body copy, the recording title, a student name
        </Text>
        <Text style={[styles.specimen, { color: t.text.secondary }]}>
          text.secondary — anything that carries content: a status word, a note
        </Text>
        <Text style={[styles.specimen, { color: t.text.muted }]}>
          text.muted — captions only; delete it and nothing is lost
        </Text>
        <Text style={[styles.specimen, { color: t.text.accent }]}>
          text.accent — links and brand text
        </Text>
        <Text style={[styles.specimen, { color: t.accent.goldText }]}>
          accent.goldText — gold deepened so it can actually be read
        </Text>
        <Text style={[styles.specimen, { color: t.text.danger }]}>
          text.danger — destructive labels
        </Text>
      </Section>

      <Section title="Feedback (functional, not brand)">
        <Swatch name="feedback.success" value={t.feedback.success} note="published, complete" />
        <Swatch name="feedback.warning" value={t.feedback.warning} note="needs attention" />
        <Swatch name="feedback.danger" value={t.feedback.danger} note="failed import, overdue" />
      </Section>

      <Section title="Borders & decoration">
        <Swatch name="border.subtle" value={t.border.subtle} />
        <Swatch name="border.strong" value={t.border.strong} />
        <Swatch name="accent.gold" value={t.accent.gold} note="decoration ONLY — never text" />
        <Swatch name="accent.sage" value={t.accent.sage} note="status dots, accent borders" />
      </Section>

      <Section title="Accent">
        <Swatch name="accent.base" value={t.accent.base} note="primary buttons, brand" />
        <Swatch name="accent.hover" value={t.accent.hover} />
      </Section>

      {/* The one raspberry field on this screen. It exists to verify the
          on-accent tokens, including that gold INVERTS on a dark fill: true gold
          reads here (~3.7:1) while the deepened goldText would read worse. */}
      <View style={styles.accentCard}>
        <Text style={styles.accentTitle}>text.inverse on accent.base</Text>
        <Text style={styles.accentMuted}>
          accent.onAccentMuted — a quieter second line on the plum
        </Text>
        <View style={styles.goldRule} />
        <Text style={styles.accentGold}>accent.gold, left true because the fill is dark</Text>
      </View>

      <Section title="Spacing — 4pt grid">
        {[1, 2, 3, 4, 6, 8].map((n) => (
          <View key={n} style={styles.spacingRow}>
            <Text style={styles.swatchName}>spacing({n})</Text>
            <View style={[styles.spacingBar, { width: spacing(n) * 4 }]} />
            <Text style={styles.swatchValue}>{spacing(n)}pt</Text>
          </View>
        ))}
      </Section>

      <Text style={styles.footer}>
        Reference only. Never reachable in a production build.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: t.bg.canvas },
  content: { padding: spacing(5), paddingBottom: spacing(12), maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' },
  h1: { fontSize: 28, fontWeight: '700', color: t.text.primary },
  lede: { fontSize: 15, color: t.text.secondary, marginTop: spacing(1), marginBottom: spacing(6) },
  section: { marginBottom: spacing(6) },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.text.secondary,
    marginBottom: spacing(2),
  },
  card: {
    backgroundColor: t.bg.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.border.subtle,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(3),
  },
  swatchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2) },
  chip: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.strong,
    marginRight: spacing(3),
  },
  swatchText: { flex: 1 },
  swatchName: { fontSize: 14, color: t.text.primary, fontWeight: '600' },
  // secondary, not muted: on a reference screen the note IS the content — it is
  // what tells you where the token belongs. muted (~2.7:1) is for text you
  // could delete without losing anything.
  swatchNote: { fontSize: 12, color: t.text.secondary, marginTop: 1 },
  swatchValue: { fontSize: 12, color: t.text.secondary, fontVariant: ['tabular-nums'] },
  specimen: { fontSize: 15, paddingVertical: spacing(1.5) },
  accentCard: {
    backgroundColor: t.accent.base,
    borderRadius: 10,
    padding: spacing(4),
    marginBottom: spacing(6),
  },
  accentTitle: { fontSize: 16, fontWeight: '700', color: t.accent.onAccent },
  accentMuted: { fontSize: 14, color: t.accent.onAccentMuted, marginTop: spacing(1) },
  goldRule: { height: 1, backgroundColor: t.accent.gold, marginVertical: spacing(3) },
  accentGold: { fontSize: 14, color: t.accent.gold },
  spacingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(1.5) },
  spacingBar: {
    height: 10,
    backgroundColor: t.accent.sage,
    borderRadius: 3,
    marginHorizontal: spacing(3),
  },
  footer: { fontSize: 12, color: t.text.muted, textAlign: 'center' },
});
