import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, IconButton } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * A centred, size-bounded dialog. Ported from the sibling kanban app, whose
 * comments carry the reasoning; the two rules worth restating here are that it
 * bounds its own height and scrolls INSIDE that bound (so it can never run off
 * a short viewport), and that the backdrop is a pointer affordance with NO
 * accessibility role — react-native-web turns a role="button" into a real
 * <button> element, and nesting the panel's controls inside one makes a space
 * keypress dismiss the sheet.
 */
export function Sheet({
  visible,
  title,
  onClose,
  closeLabel = 'Close',
  closeTestID,
  closeAt = 'foot',
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  closeTestID?: string;
  /**
   * Where the way out is. A MENU or a picker closes from a × beside its title,
   * as menus do; a full-width bar under one menu of three options was the
   * biggest thing in it. A sheet whose way out is one of its answers — Cancel
   * under a form, Stay under "Leave now?" — keeps it at the foot, full width.
   */
  closeAt?: 'foot' | 'corner';
  children: ReactNode;
}) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} focusable={false}>
        {/* Absorbs taps so a press inside does not dismiss via the backdrop.
            The testID is what the layout sweep scopes to: RNW portals a Modal
            out of the app root without hiding it, so a whole-document query
            measures the SCREEN BEHIND the sheet — the panel would have to lose
            its width cap entirely before anything noticed. */}
        <Pressable testID="sheet-panel" style={styles.panel} onPress={() => {}}>
          {closeAt === 'corner' ? (
            <View style={styles.titleRow}>
              <Text style={[styles.title, styles.titleInRow]}>{title}</Text>
              <IconButton testID={closeTestID} icon="close" label={closeLabel} bare onPress={onClose} />
            </View>
          ) : (
            <Text style={styles.title}>{title}</Text>
          )}
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {/* Quiet, and deliberately: this is the sheet's way OUT, sitting
              under a form whose primary is the reason the sheet is open. Filled,
              full width, it outweighed a disabled "Create account" above it. */}
          {closeAt === 'foot' ? (
            <Button testID={closeTestID} label={closeLabel} variant="quiet" onPress={onClose} block />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One row inside a Sheet. */
export function SheetOption({
  label,
  detail,
  tone = 'normal',
  selected,
  testID,
  onPress,
}: {
  label: string;
  detail?: string;
  tone?: 'normal' | 'danger';
  /**
   * Whether this row is the CURRENT choice, when the sheet is a picker
   * (`Select`). Passing it at all makes the row a radio — one of a set, exactly
   * one in force — marked with the accent tint the app uses for "on" everywhere
   * else. Left undefined the row is a plain button, as in the More sheet.
   */
  selected?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={label}
      // `aria-checked`, because the role is `radio` — see the create-student
      // picker for the same choice.
      aria-checked={selected}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected ? styles.optionSelected : null,
        pressed ? styles.optionPressed : null,
      ]}
    >
      <Text style={[styles.optionLabel, tone === 'danger' ? styles.optionDanger : null]}>
        {label}
      </Text>
      {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

/** A quiet divider label grouping rows inside a Sheet. */
export function SheetSection({ label }: { label: string }) {
  return <Text style={styles.section}>{label.toUpperCase()}</Text>;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing(4),
    backgroundColor: t.effect.overlay,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    backgroundColor: t.bg.raised,
    borderColor: t.border.strong,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(2),
  },
  title: { fontSize: 18, fontWeight: '700', color: t.text.primary },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing(2) },
  titleInRow: { flexShrink: 1 },
  body: { flexGrow: 0 },
  bodyContent: { gap: spacing(1) },
  option: {
    borderRadius: 8,
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(3),
    minHeight: 44,
    justifyContent: 'center',
  },
  optionPressed: { backgroundColor: t.bg.inset },
  optionSelected: { backgroundColor: t.bg.accentSoft },
  optionLabel: { fontSize: 15, fontWeight: '600', color: t.text.primary },
  optionDanger: { color: t.text.danger },
  optionDetail: { fontSize: 13, color: t.text.secondary, marginTop: 2 },
  section: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: t.text.secondary,
    marginTop: spacing(3),
    marginBottom: spacing(1),
    paddingHorizontal: spacing(3),
  },
});
