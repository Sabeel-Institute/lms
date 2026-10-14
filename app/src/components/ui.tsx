import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LAYOUT_WIDTHS, getTheme, spacing, type LayoutWidth } from '../theme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListenerError } from '../liveQuery';
import { useRoomy, useWide } from '../useWidth';
import { KbScroll } from './KbScroll';
import { Sheet } from './Sheet';

const t = getTheme();

/**
 * Shared primitives. Brand rules live here rather than in each screen:
 * chrome is ivory, raspberry is reserved for the primary action, and every
 * colour comes from a semantic token (ESLint rejects a literal anywhere else).
 */

/**
 * WHETHER THIS SCREEN MUST PAY FOR THE STATUS BAR ITSELF.
 *
 * True on the tab roots, which run with no stack header. Set by the navigation
 * shell, which is the only thing that knows which route is showing; a screen
 * cannot answer it, and hard-coding it per screen would be a second copy of the
 * shell's own list.
 */
export const ScreenOwnsTopInset = createContext(false);

/**
 * Page wrapper. Renders the latest live-data error above the content — a
 * rejected listener otherwise dies as a console warning nobody sees on a phone.
 */
export function Screen({ title, titleLink, subtitle, status, parent, width = 'read', actions, fill = false, children }: {
  title?: string;
  /**
   * Makes the title itself the way to the thing it names — a student's name
   * on their progress page opening their profile. The name is already the
   * biggest text on the screen; a chevron after it says it goes somewhere, and
   * the accessible label says where.
   */
  titleLink?: { testID: string; label: string; onPress: () => void };
  /** Words under the title; or an element of its own, as a student's `EmailText`. */
  subtitle?: string | ReactElement;
  /**
   * Which maximum this screen's content stops growing at. See `LAYOUT_WIDTHS` —
   * prose and forms want a narrow reading column, collections want the room.
   * Defaulting to `read` is deliberate: a screen that has not thought about it
   * is far more likely to be a form than a grid, and an over-narrow column is a
   * cosmetic fault where an over-wide one is unreadable.
   */
  width?: LayoutWidth;
  /**
   * Screen-level actions — icons: a plus that adds, a pencil that edits, a ⋮
   * that holds the rest — beside the title they act on, at every width.
   */
  actions?: ReactNode;
  /** The state of the thing this screen is about. Rendered as a lamp on the
   *  lede line under the title — see `StatusLight`. */
  status?: string;
  /**
   * The thing this screen belongs to, as the first part of the subtitle and a
   * way back to it. The subtitle on a nested screen already NAMED its parent —
   * this makes that name the link rather than adding a second one, so the header
   * gains an affordance and no new line.
   *
   * Not a substitute for the header's Back arrow, which returns wherever you
   * came from: two screens down inside a course, that is the list you came
   * through, not the course. Both are useful and they do different things.
   */
  parent?: { label: string; testID: string; onPress: () => void };
  /**
   * The screen's area held still: no scrolling, and the content fills it, so a
   * child with `flex: 1` is exactly the room left under the heading — between
   * it and the bar, and the docked player when one is up. For a screen that
   * sizes one thing to the window: a help film has to fit, controls and all.
   */
  fill?: boolean;
  children: ReactNode;
}) {
  const listenerError = useListenerError();
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const ownsTopInset = useContext(ScreenOwnsTopInset);
  const max = LAYOUT_WIDTHS[width];
  const heading =
    title || subtitle || parent ? (
      <View style={styles.headRow}>
        <View style={styles.headText}>
          {/* THE TITLE STARTS AT THE MARGIN. The status lamp used to hold a 56px
              gutter to its left, which pushed the H1 68px right of every section
              label beneath it — the page read as indented from its own content.
              It rides the lede line instead, where it is still the first thing
              under the name. */}
          {title && titleLink ? (
            <Pressable
              testID={titleLink.testID}
              role="link"
              aria-label={titleLink.label}
              onPress={titleLink.onPress}
              style={({ pressed }) => [styles.h1Link, pressed ? styles.h1LinkPressed : null]}
            >
              <Text style={styles.h1} role="heading" aria-level={1} testID="screen-title">
                {title}
                <Text style={styles.h1Chevron}>{' ›'}</Text>
              </Text>
            </Pressable>
          ) : title ? (
            <Text style={styles.h1} role="heading" aria-level={1} testID="screen-title">
              {title}
            </Text>
          ) : null}
          {status ? <StatusLight status={status} /> : null}
          {subtitle !== undefined && typeof subtitle !== 'string' ? (
            <View style={styles.ledeBlock}>{subtitle}</View>
          ) : parent || subtitle ? (
            <Text style={styles.lede}>
              {parent ? (
                // Underlined, not coloured alone: colour by itself does not say
                // "link" to anyone who cannot see it as different from the text
                // beside it. NESTED in the subtitle Text so it wraps with the
                // rest of the line instead of being a block of its own.
                <Text
                  style={styles.ledeLink}
                  role="link"
                  testID={parent.testID}
                  aria-label={`Go to ${parent.label}`}
                  onPress={parent.onPress}
                >
                  {parent.label}
                </Text>
              ) : null}
              {parent && subtitle ? ' · ' : ''}
              {subtitle}
            </Text>
          ) : null}
        </View>
        {/* ONE POSITION, at every width. Rendering these in the heading row on a
            wide screen and as a separate block below it on a phone put the same
            element at two different places in the tree, so dragging a browser
            across the breakpoint unmounted them — closing an open "Add a …"
            sheet and throwing away a half-typed form. The row wraps instead. */}
        {actions ? <View style={styles.headActions}>{actions}</View> : null}
      </View>
    ) : null;
  const content = [
    styles.content,
    wide ? styles.contentWide : null,
    ownsTopInset ? { paddingTop: insets.top + spacing(8) } : null,
    { maxWidth: max },
  ];
  const body = (
    <>
      {/* Chrome is ivory with a dark title, never a raspberry app bar: a
          brand-coloured bar on every screen puts raspberry far past its share. */}
      {heading}
      {listenerError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{listenerError}</Text>
        </View>
      ) : null}
      {children}
    </>
  );
  if (fill) {
    return (
      <View style={styles.canvas}>
        <View style={[content, styles.contentFill]} testID="screen-fill">
          {body}
        </View>
      </View>
    );
  }
  return (
    <KbScroll style={styles.canvas} contentContainerStyle={content}>
      {body}
    </KbScroll>
  );
}

/**
 * How the grid a card or row sits in draws it: on its own (`none`), as one of
 * a grid's cards (`cards`), or as a row of the one card a list of rows becomes
 * on a phone (`rows`). A card in a grid drops its own bottom margin, so the
 * grid's gap is the only space between cards — the two together put twice the
 * room between cards stacked on a phone as beside each other on a laptop.
 */
type GridLook = 'none' | 'cards' | 'rows';
const GridLookContext = createContext<GridLook>('none');

/**
 * What a card or row adds to its own style for the grid it sits in: no
 * margin of its own in any grid, and no border or corners as a row of the one
 * card a list of rows becomes. `Card` and `ListRow` apply it; a hand-built
 * card in a `Grid` applies it too, or it keeps the margin the grid replaced.
 */
export function useGridCell(): StyleProp<ViewStyle> {
  const look = useContext(GridLookContext);
  return look === 'none' ? null : look === 'cards' ? styles.cardInGrid : [styles.cardInGrid, styles.cardAsRow];
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={[styles.card, useGridCell()]}>{children}</View>;
}

/** One count on a `CountsLine`. */
export interface Count {
  value: number;
  /** The word after the number: "required", "not complete". */
  label: string;
  /** Drawn in the danger colour when above zero: "missed". */
  alarm?: boolean;
  testID?: string;
}

/**
 * Counts on one line — "8 required · 0 completed · 3 missed" — each number
 * bold and JOINED to its words, so a narrow screen wraps between counts and
 * never splits "37" from "not complete". Replaced the tiles of four boxes
 * that took a phone's first screen to say one sentence.
 */
export function CountsLine({ lead, counts, testID }: { lead?: string; counts: Count[]; testID?: string }) {
  return (
    <Text style={styles.countsLine} testID={testID}>
      {lead ? `${lead}: ` : ''}
      {counts.map((c, i) => (
        <Text key={c.label}>
          {/* The dot rides with the count AFTER it, so a wrap never leaves one
              dangling at the end of a line. */}
          {i > 0 ? '  \u00B7\u00A0\u00A0' : ''}
          <Text testID={c.testID} style={[styles.countsNum, c.alarm && c.value > 0 ? styles.countsAlarm : null]}>
            {c.value}
          </Text>
          {`\u00A0${c.label.replace(/ /g, '\u00A0')}`}
        </Text>
      ))}
    </Text>
  );
}

/**
 * An email address on ONE line. Wrapped, it broke at "example." and put "com"
 * on a line of its own. Cut short when it does not fit — in the middle on a
 * phone, so the name before the @ and the domain both stay; at the end in a
 * browser, which has no middle cut. ONE TEXT, so it copies and is read out as
 * one address: two pieces side by side copied as two lines.
 */
export function EmailText({
  email,
  suffix,
  lede,
  testID,
}: {
  /** None for a deleted account: its row is its name alone. */
  email: string | null;
  /** Words after the address that never give way: " · admin". */
  suffix?: string;
  /** Set as a page's subtitle rather than a row's detail. */
  lede?: boolean;
  testID?: string;
}) {
  const look = lede ? styles.ledeText : styles.rowDetail;
  if (email === null) return null;
  return (
    <View testID={testID} style={styles.email}>
      <Text style={[look, styles.emailText]} numberOfLines={1} ellipsizeMode="middle">
        {email}
      </Text>
      {suffix ? <Text style={[look, styles.emailSuffix]}>{suffix}</Text> : null}
    </View>
  );
}

/**
 * A section's heading, and an action that belongs to the whole section — the
 * plus that adds to its list — at the right-hand end of the same line.
 */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  if (!action) return <Text style={styles.sectionTitle}>{children}</Text>;
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={[styles.sectionTitle, styles.sectionTitleInRow]}>{children}</Text>
      {action}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy,
  disabled,
  block,
  hug,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  busy?: boolean;
  disabled?: boolean;
  /**
   * Keep the phone's full-width shape at every width.
   *
   * The escape hatch for a button that SHOULD span its container whatever the
   * width — a sheet's own dismiss, and the form buttons inside one, where the
   * container is already a narrow panel. Everywhere else a standalone button
   * stretched to 1400px reads as an unfinished phone layout.
   */
  block?: boolean;
  /** Size to the label at EVERY width, not only on a wide screen. */
  hug?: boolean;
  testID?: string;
}) {
  const isDisabled = disabled || busy;
  const roomy = useRoomy();
  const inRowCell = useContext(RowCellContext);
  const style =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'danger'
        ? styles.btnDanger
        : variant === 'quiet'
          ? styles.btnQuiet
          : styles.btnSecondary;
  const textStyle =
    variant === 'secondary'
      ? styles.btnSecondaryText
      : variant === 'quiet'
        ? styles.btnQuietText
        : styles.btnPrimaryText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        inRowCell ? styles.btnFill : null,
        // A button laid out as a column child stretches to the column on a
        // phone, which is the right primary-action shape there and a bar across
        // the window on anything larger. Inside a Row it is already
        // content-width, so this only changes the stretched case.
        (hug || roomy) && !block ? styles.btnWide : null,
        style,
        pressed && !isDisabled ? styles.btnPressed : null,
        isDisabled ? styles.btnDisabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'secondary' ? t.text.primary : t.accent.onAccent} />
      ) : (
        // A label may wrap between words, but must never break INSIDE one:
        // "Submit att / endance" is what a phone at a large accessibility font
        // size does otherwise. Two lines are allowed, and if a single word still
        // does not fit, the text scales down rather than splitting — the person
        // asked for large text, so shrink only as the last resort and only as far
        // as minimumFontScale.
        <Text
          style={[styles.btnText, isDisabled ? styles.btnDisabledText : textStyle]}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * A single-glyph action for a list row — remove, disable, re-enable.
 *
 * A `glyph` is a TEXT-presentation character (`×`, `↺`), never emoji: an emoji
 * renders as a colour bitmap that ignores `color`, so a control that should
 * read as destructive would not. `×` and `↺` are typographic marks, which the
 * font draws better than the icon set does. An `icon` is a MaterialIcons
 * pictogram, for what no mark says: a file's bin, the paperclip that adds one.
 *
 * Icon-only means the label is invisible, so `label` is required and becomes the
 * accessibility name — a screen reader gets "Remove Fatima Ahmed from the
 * course", not "times". The square is 44pt because that is the minimum touch
 * target, even though the glyph inside is small.
 */
export function IconButton({
  glyph,
  icon,
  label,
  variant = 'secondary',
  bare,
  busy,
  disabled,
  onPress,
  testID,
}: ({ glyph: string; icon?: undefined } | { icon: ComponentProps<typeof MaterialIcons>['name']; glyph?: undefined }) & {
  /** Required: with no visible text this IS the button's name. */
  label: string;
  variant?: 'secondary' | 'danger';
  /**
   * No tile behind it: the bin and the paperclip a list of files carries
   * inline, where a tinted square on every row would outshout the files.
   */
  bare?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const isDisabled = disabled || busy;
  const ink = variant === 'danger' ? t.text.danger : bare ? t.text.secondary : t.text.primary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.iconBtn,
        bare ? null : variant === 'danger' ? styles.iconBtnDanger : styles.iconBtnSecondary,
        pressed && !isDisabled ? (bare ? styles.iconBtnBarePressed : styles.btnPressed) : null,
        isDisabled ? (bare ? styles.iconBtnBareDisabled : styles.btnDisabled) : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : icon ? (
        <MaterialIcons name={icon} size={22} color={ink} />
      ) : (
        <Text
          style={[
            styles.iconGlyph,
            variant === 'danger' ? styles.iconGlyphDanger : styles.iconGlyphSecondary,
            isDisabled ? styles.btnDisabledText : null,
          ]}
        >
          {glyph}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * One entry in a list — a person, a cohort, anything with a name and a couple of
 * controls. Title (and status) on the first line, detail under it, actions on
 * the right of the same line, wrapping to their own line when the title needs
 * the width.
 *
 * `onPress` makes the identity block open the thing. The actions stay outside
 * that press target so tapping Archive cannot be mistaken for opening.
 */
export function ListRow({
  name,
  status,
  detail,
  actions,
  actionsPinned = false,
  onPress,
  openLabel,
  testID,
}: {
  name: string;
  status?: ReactNode;
  /** A line under the name: words, or an `EmailText`. */
  detail?: ReactNode;
  actions?: ReactNode;
  /**
   * Keep the actions on the name's line, pinned right and centred, letting a
   * long name WRAP instead of pushing them onto their own row. For a row whose
   * only action is a single icon, wrapping reads as a layout fault rather than
   * as making room.
   */
  actionsPinned?: boolean;
  onPress?: () => void;
  /** Accessibility name for the press target; visually the row speaks for itself. */
  openLabel?: string;
  testID?: string;
}) {
  const inGrid = useGridCell();
  const ident = (
    <>
      <View style={styles.rowTitleLine}>
        <Text style={styles.rowTitle}>{name}</Text>
        {status ?? null}
      </View>
      {typeof detail === 'string' ? <Text style={styles.rowDetail}>{detail}</Text> : (detail ?? null)}
    </>
  );
  return (
    <View style={[styles.rowCard, inGrid]}>
      <View style={[styles.rowHead2, actionsPinned ? styles.rowHeadPinned : null]}>
        {/* Title, status and detail are ONE block, so when the actions wrap to
            their own line they go below the whole identity rather than landing
            between the title and its detail. */}
        {onPress ? (
          <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={openLabel ?? `Open ${name}`}
            onPress={onPress}
            style={[styles.rowIdent, actionsPinned ? styles.rowIdentPinned : null]}
          >
            {ident}
          </Pressable>
        ) : (
          <View style={[styles.rowIdent, actionsPinned ? styles.rowIdentPinned : null]}>
            {ident}
          </View>
        )}
        {actions ? (
          <View style={[styles.rowActions, actionsPinned ? styles.rowActionsPinned : null]}>
            {actions}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A text box's look, for the inputs that are not a `TextInput` — the rich-text
 * editor on both surfaces. One definition, so a formatted field and a plain
 * one beside it on the same form cannot drift apart.
 */
export const inputLook = StyleSheet.create({
  label: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  box: {
    backgroundColor: t.bg.inset,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(3),
    fontSize: 15,
    color: t.text.primary,
    minHeight: 44,
  },
});

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  autoCapitalize = 'none',
  keyboardType,
  multiline,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'words';
  keyboardType?: 'email-address' | 'default';
  /**
   * A paragraph, not a value. The field grows and wraps instead of scrolling a
   * single line sideways — a session's notes run to several sentences and were
   * being edited through a one-line box that truncated mid-word.
   */
  multiline?: boolean;
  testID?: string;
}) {
  const roomy = useRoomy();
  // The measured height of a multiline field's content, once it has one. Null
  // until then, so the field opens at `inputMultiline`'s four-line floor.
  const [grown, setGrown] = useState<number | null>(null);
  /*
   * THE REPORTED HEIGHT, USED AS-IS. It already includes the padding — on the
   * web it is the textarea's `scrollHeight`, on Android the view's — so adding
   * the padding again made every measurement 24px taller than the height it had
   * just applied, and the handler fed itself until `maxHeight` stopped it: every
   * note, however short, pinned to the 312px ceiling with a screenful of dead
   * space under four lines of text.
   *
   * `useCallback`, because react-native-web memoises its content-size plumbing
   * on this function's identity and re-measures whenever it changes — an inline
   * arrow re-measures on every render, which is what turned a one-off overshoot
   * into a loop.
   */
  const onGrow = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) =>
      setGrown(Math.ceil(e.nativeEvent.contentSize.height)),
    [],
  );
  return (
    <View style={[styles.field, roomy ? styles.fieldWide : null]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        testID={testID}
        // Named by its label: the Text above it is seen, not read out with it.
        accessibilityLabel={label}
        style={[
          styles.input,
          multiline ? styles.inputMultiline : null,
          multiline && grown ? { height: grown } : null,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.text.muted}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        multiline={multiline}
        // Four, to agree with `inputMultiline`'s minHeight. Android sizes the
        // box from this and web from the style; disagreeing gives the same
        // field two different heights on the two platforms.
        numberOfLines={multiline ? 4 : undefined}
        onContentSizeChange={multiline ? onGrow : undefined}
        textAlignVertical={multiline ? 'top' : undefined}
      />
    </View>
  );
}

/**
 * A number inside its sentence — "Out of [10]", "[8] / 10" — in a box as wide
 * as the number. A full-width field for two digits read as a paragraph to
 * write, a line to itself above the words that say what it is.
 */
export function InlineNumber({
  before,
  after,
  label,
  value,
  onChangeText,
  testID,
}: {
  before?: string;
  after?: string;
  /** The whole sentence, for a screen reader: "Grade out of 10". */
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  testID?: string;
}) {
  return (
    <View style={styles.inlineNumber}>
      {before ? <Text style={styles.inlineNumberText}>{before}</Text> : null}
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        style={[styles.input, styles.inlineNumberBox]}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        inputMode="decimal"
        autoCorrect={false}
        selectTextOnFocus
      />
      {after ? <Text style={styles.inlineNumberText}>{after}</Text> : null}
    </View>
  );
}

/** An inline message. `tone` picks the functional colour, never a brand hue. */
export function Notice({ tone, children }: { tone: 'info' | 'error' | 'success'; children: ReactNode }) {
  const bg =
    tone === 'error' ? t.bg.dangerSoft : tone === 'success' ? t.bg.sage : t.bg.goldSoft;
  const fg =
    tone === 'error' ? t.text.danger : tone === 'success' ? t.feedback.success : t.text.secondary;
  return (
    // An error is announced as one, and is what a check looks for when it
    // asserts that nothing went wrong.
    <View
      role={tone === 'error' ? 'alert' : undefined}
      testID={tone === 'error' ? 'notice-error' : undefined}
      style={[styles.notice, { backgroundColor: bg }]}
    >
      <Text style={[styles.noticeText, { color: fg }]}>{children}</Text>
    </View>
  );
}

/**
 * A status word. The dot carries the colour; the label stays readable text —
 * colouring the label itself fails the moment the colour is a light one.
 *
 * Mapped explicitly rather than "anything unrecognised is a warning": that
 * default painted `published` amber, which reads as a problem on a recording
 * that is working exactly as intended. Amber is reserved for states a human
 * has to act on.
 */
const STATUS_TONE: Record<string, 'good' | 'attention' | 'neutral'> = {
  active: 'good',
  published: 'good',
  // An assignment out with its class.
  posted: 'good',
  needsAttention: 'attention',
  pending: 'attention',
  draft: 'neutral',
  unpublished: 'neutral',
  archived: 'neutral',
  inactive: 'neutral',
  // NEUTRAL, with its siblings. A disabled account is a reversible
  // administrative off-state, exactly like an archived course or an unpublished
  // recording — and this app reserves the alarm colour for permanent deletion,
  // which is the same call already made for the Disable button itself.
  disabled: 'neutral',
};

/** One place decides what a status colour means; chip and light both read it. */
function statusColour(status: string): string {
  const tone = STATUS_TONE[status] ?? 'neutral';
  // NO 'bad'. Every off-state this app has — archived, inactive, unpublished,
  // disabled — is reversible administration, and the danger colour is reserved
  // for permanent deletion. A status dot is never the place it is spent.
  return tone === 'good'
    ? t.feedback.success
    : tone === 'attention'
      ? t.feedback.warning
      : t.text.muted;
}

/**
 * A status word, in English.
 *
 * The chip prints a FIELD VALUE, and one of them is camelCase — so a recording
 * card read "needsAttention" beside a summary line that said the same thing in
 * words. Only the values that are not already a word need an entry.
 */
const STATUS_WORD: Record<string, string> = {
  needsAttention: 'needs attention',
};

/**
 * A status field value as a person reads it — lower case, spaced.
 *
 * Exported because the library screen writes the same six words twice over: on
 * the chip of every card, and on the filter above them. Those were two maps,
 * each carrying its own `needsAttention: 'needs attention'`, so a status added
 * to one appeared raw in the other.
 */
export function statusWord(status: string): string {
  return STATUS_WORD[status] ?? status;
}

export function StatusChip({ status }: { status: string }) {
  return (
    <View style={styles.tag}>
      <View style={[styles.tagDot, { backgroundColor: statusColour(status) }]} />
      <Text style={styles.tagText}>{statusWord(status)}</Text>
    </View>
  );
}

/**
 * The status of the thing a whole screen is about: a dot and its word, side by
 * side on the lede line beneath the title.
 *
 * Distinct from `StatusChip`, which is an inline tag in a list row. Set beside a
 * page heading a chip reads as an afterthought stuck to the end of the name; a
 * lamp reads as the state of the thing and is findable in the same spot on every
 * screen. It sits BELOW the title rather than left of it because a gutter to the
 * left pushed the H1 68px right of every section label under it — see the note
 * in `Screen`.
 */
function StatusLight({ status }: { status: string }) {
  return (
    <View style={styles.light} accessibilityLabel={`Status: ${status}`}>
      <View style={[styles.lightDot, { backgroundColor: statusColour(status) }]} />
      <Text style={styles.lightText} numberOfLines={1}>
        {status}
      </Text>
    </View>
  );
}

/**
 * A collection that flows into as many columns as fit.
 *
 * The single most visible difference between a designed desktop layout and a
 * stretched phone one: a list of cards down the middle of a 1500px window is
 * mostly empty space, and the same cards at 320px must be one per row.
 *
 * `min` IS THE NARROWEST A CELL MAY BE, and it is what decides where two
 * columns start. The content box at a 720px viewport is 680px, so two cells
 * plus the 12px gap have to fit in that: anything above 334 stays
 * single-column across the whole 720–899 band. Every grid holding a CARD passes
 * 320 or 330 for that reason — 340 was off by twelve pixels and read as a broken
 * breakpoint. The ledger's four listener sections pass 300: their rows are a
 * name and a percentage rather than a card with actions, so they need less.
 *
 * Required rather than defaulted: the number decides the layout at every width,
 * and a grid that did not state it would be laid out by whatever the default
 * happened to be that day.
 */
export function Grid({
  min,
  rows = false,
  children,
}: {
  min: number;
  /**
   * A LIST OF ROWS — people, entries — rather than of cards: on one column it
   * is drawn as one card of rows divided by hairlines, the way a phone shows a
   * list, instead of a stack of separate cards each carrying its own border
   * and margin. Two columns and more stay cards.
   */
  rows?: boolean;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const cells = Children.toArray(children);

  /*
   * MEASURED, and measured against THE SPACE THIS GRID HAS — not against the
   * app's navigation breakpoint.
   *
   * Two things follow, and both were bugs. Gating on `useWide()` meant a 720px
   * window got one column however much room a cell needed, because the rail
   * appears at 900 — a number about navigation that has nothing to say about
   * whether two cards fit. And returning a bare fragment in that case put the
   * children at a different tree position, so dragging a window across 900px
   * unmounted and remounted every cell — which for cells holding live listeners
   * flashes an empty state across the whole list. One shape, always.
   *
   * `flexBasis` + `flexGrow` would share the row evenly, which is right until
   * the last row is short: a single leftover card grows to the full width and
   * reads as a different, more important component than the ones above it. So
   * the column count is computed and every cell gets the same fixed width, and
   * the last row lines up with the rest and simply ends.
   */
  const gap = spacing(3);
  const fits = width > 0 ? Math.max(1, Math.floor((width + gap) / (min + gap))) : 1;
  /*
   * NEVER MORE COLUMNS THAN THERE ARE CELLS.
   *
   * Dividing by the columns that FIT rather than the ones in use made a grid
   * narrower the wider the window got: two cards in a 1116px column were sized
   * as a third of it, 364px each, where the same two had 436px at 1024 — and a
   * course name that fitted on the smaller screen truncated on the larger, next
   * to 500px of nothing. Below `min` there is only ever one column, so this
   * changes nothing on a phone.
   */
  const cols = Math.max(1, Math.min(fits, cells.length));
  /*
   * EVERY SECTION ENDS AT THE SAME RIGHT EDGE, so a short row is a wide cell
   * rather than a narrow one floating in a gap.
   *
   * Capping the cell instead — at the width two columns would have needed —
   * gave a page four sections ending at four different x positions, and put the
   * NARROWEST card under the heading that matters most, because the one thing
   * blocking every student's access is usually the only row in its group.
   */
  // FLOORED. `cols * cell + gap * (cols - 1)` is exactly the container width in
  // real arithmetic, but Yoga rounds child widths to the pixel grid — a fraction
  // over and the last cell wraps onto a line of its own at a fixed narrow width.
  const cell =
    width > 0 && fits > 1 ? Math.floor((width - gap * (cols - 1)) / cols) : undefined;

  const asRows = rows && cols === 1;
  return (
    <View style={[styles.grid, asRows ? styles.gridAsRows : null]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <GridLookContext.Provider value={asRows ? 'rows' : 'cards'}>
      {cells.map((child, i) => (
        /*
         * KEYED BY THE CHILD'S OWN KEY, never by index.
         *
         * `Children.toArray` already carries each child's key, and an index key
         * over it throws that away: insert or remove one row and every cell
         * after it is a different component to React, so all of them remount.
         * Cells here hold live Firestore listeners (a student's class cards do),
         * and `liveQuery` resets to `empty` on resubscribe — so one enrolment
         * change flashed "No attendance taken yet" across the whole list.
         */
        <View
          key={(isValidElement(child) && child.key) || i}
          // One column: a full-width BASIS, so the cell takes the line and the
          // next one wraps beneath it. A percentage `width` on a flex item does
          // not reliably resolve against a wrapping row — the cards came out
          // sized to their own text, each a different width.
          style={[styles.gridCell, cell ? { width: cell } : styles.gridCellFull, asRows && i > 0 ? styles.gridRowDivider : null]}
        >
          {child}
        </View>
      ))}
      </GridLookContext.Provider>
    </View>
  );
}

/**
 * ONE COLUMN OF ROWS AT EVERY WIDTH, divided by hairlines inside one card —
 * how `Grid rows` draws itself on a phone — for a list read top to bottom
 * whatever the window: an assignment's students, a course's pages.
 */
export function RowList({ testID, children }: { testID?: string; children: ReactNode }) {
  return (
    <View testID={testID} style={styles.rowList}>
      <GridLookContext.Provider value="rows">
        {Children.toArray(children).map((child, i) => (
          <View key={(isValidElement(child) && child.key) || i} style={i > 0 ? styles.gridRowDivider : null}>
            {child}
          </View>
        ))}
      </GridLookContext.Provider>
    </View>
  );
}

/**
 * A row that goes somewhere: its name, a line about what is there, and a
 * chevron. The whole row is the target.
 */
export function NavRow({
  label,
  caption,
  onPress,
  testID,
}: {
  label: string;
  /** What is there: words, or a `CountsLine`. */
  caption?: ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, pressed ? styles.navRowPressed : null]}
    >
      <View style={styles.navText}>
        <Text style={styles.rowTitle}>{label}</Text>
        {typeof caption === 'string' ? <Text style={styles.rowDetail}>{caption}</Text> : (caption ?? null)}
      </View>
      <MaterialIcons name="chevron-right" size={22} color={t.text.muted} />
    </Pressable>
  );
}

/**
 * "Add a …" — a header action that opens the form in a sheet.
 *
 * The shape this replaced was a form pinned above the list on every one of
 * these screens. It is wrong at both widths and for the same reason: creating a
 * cohort, a course or a student is a few-times-a-term task, and the list is
 * what every other visit came for. On a phone the form pushed the list below
 * the fold; on a laptop it put a banner of empty fields across the top of a
 * 1400px window and left the content stranded under it.
 *
 * As a modal task it also gets two things for free. The form is the same at
 * every width, so there is no second layout to keep honest — and on a build
 * where the affordance must not exist at all (see `accountCreation.ts`) there
 * is exactly one thing to leave out.
 */
export function AddAction({
  label,
  title,
  testID,
  children,
}: {
  /**
   * What the plus does, in words — "Add a student". It is the button's name
   * for a screen reader and the sheet's purpose; the plus itself carries no
   * words (Faisal, 2026-10-14: a plus on the heading line, as lists add).
   */
  label: string;
  /** The sheet's heading. Usually the same words. */
  title: string;
  testID?: string;
  /** The form. Close it from inside with `useAddAction`. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AddActionContext.Provider value={() => setOpen(false)}>
      {/* A PLUS ON THE HEADING LINE. A labelled button wrapped to a line of its
          own under the title on a phone, the first thing on a page whose job
          is the list underneath. */}
      <IconButton testID={testID} icon="add" label={label} onPress={() => setOpen(true)} />
      <Sheet visible={open} title={title} onClose={() => setOpen(false)} closeLabel="Cancel">
        {children}
      </Sheet>
    </AddActionContext.Provider>
  );
}

const AddActionContext = createContext<() => void>(() => {});

/** Close the sheet from inside the form, once the thing is created. */
export function useAddAction(): () => void {
  return useContext(AddActionContext);
}

/**
 * The filter pills that sit above a list — one of N, always exactly one chosen.
 *
 * ONE COMPONENT, BECAUSE FOUR COPIES HAD ALREADY DRIFTED. The recording ledger,
 * a student's ledger, the library and the Zoom import each carried the same
 * twelve lines of `Pressable` and the same six style keys, and by the time they
 * were collected they announced themselves three different ways — one a
 * `button` with `aria-pressed`, two `radio`s with `aria-checked`, one of those
 * with no label at all — and drew their text at two different sizes. Nothing
 * could have caught that: every copy passes every check on its own.
 *
 * A RADIO GROUP, which is what the control is. Exactly one option is chosen and
 * choosing another releases the first, so `aria-pressed` on independent buttons
 * was the wrong shape — it says four things are each on or off, and a screen
 * reader gives no hint that they are one choice.
 *
 * DISTINCT FROM `Segmented`, which is a switch between two views of the same
 * subject (Students / Staff). These narrow a list without changing what the
 * screen is about, so they wrap in a row rather than sitting in a box.
 */
export function Chips<T extends string>({
  value,
  options,
  testIdPrefix,
  onChange,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  /** Each pill gets `${testIdPrefix}-${value}`. */
  testIdPrefix: string;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.chips} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={`${testIdPrefix}-${o.value}`}
            accessibilityRole="radio"
            aria-checked={on}
            aria-disabled={disabled}
            accessibilityLabel={o.label}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={[styles.chip, on ? styles.chipOn : null, disabled ? styles.chipDisabled : null]}
          >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A two-or-three way switch between views of the same subject.
 *
 * Not navigation: every segment is the same screen showing a different slice,
 * so it must not push, must not appear in history, and must not get a Back. The
 * People tab is the case it exists for — students and staff are one destination
 * with two lists, and giving each its own tab would spend a permanent slot on a
 * screen an admin opens a few times a term.
 */
export function Segmented<T extends string>({
  value,
  options,
  testIdPrefix = 'segment',
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  /** Each segment gets `${testIdPrefix}-${value}`. */
  testIdPrefix?: string;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={`${testIdPrefix}-${o.value}`}
            accessibilityRole="tab"
            aria-selected={on}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              styles.segment,
              on ? styles.segmentOn : null,
              pressed ? styles.segmentPressed : null,
            ]}
          >
            <Text style={[styles.segmentText, on ? styles.segmentTextOn : null]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Set inside a `Row`, so a button knows to fill the cell it was given. */
const RowCellContext = createContext(false);

/**
 * Lays controls out side by side, wrapping instead of overflowing.
 *
 * Each child is wrapped rather than styled directly, so the flex behaviour
 * belongs to the row: putting flexGrow on the button itself made every
 * standalone button stretch to fill the column it sat in — and putting it back
 * there, to make a pair come out level, did the same thing a second time.
 *
 * Items GROW to share a line but never SHRINK (see `rowItem`). Shrinking is what
 * produced a Publish button squeezed to a third of its neighbour with its label
 * broken mid-word — "Publ / ish" — on a real phone. A row is allowed to wrap; it
 * is not allowed to crush a control.
 *
 * THE FLOOR IS THE 150px BASIS, NOT THE TEXT. Every cell on a line is the same
 * width and at least 150px wide, and a label too long for that wraps onto a
 * second line — which is why the buttons inside also stretch to the tallest.
 * Letting the text set the floor instead sounds safer and is not: two cells then
 * come out different widths, and a pair whose labels do not both fit overflows
 * the card and lands one control on top of the other.
 */
/**
 * A FRAGMENT IS ITS CHILDREN, here. `Children.map` hands a fragment over as
 * ONE child, so two buttons written as `<>…</>` (one branch of a condition)
 * shared a single cell, and on a phone with large text the first was crushed
 * to "Po / st" — the very thing the cells exist to prevent.
 */
function cells(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment ? cells(child.props.children) : [child],
  );
}

export function Row({ children }: { children: ReactNode }) {
  const roomy = useRoomy();
  return (
    <RowCellContext.Provider value={true}>
      <View style={styles.row}>
        {cells(children).map((child, i) =>
          child ? (
            /*
             * THE CELLS SHARE THE WIDTH ON A PHONE AND NOT ON A LAPTOP.
             *
             * Growing each cell is what makes two actions on a 320px screen come
             * out as two equal halves instead of one wide button and one narrow
             * one. At 1400px the same rule gives each cell 537px and leaves its
             * button sitting at its natural width in the middle of it — so a
             * pair of related actions ends up 400px apart with nothing between
             * them, reading as two unrelated controls. It is the single most
             * visible "stretched phone layout" tell in the app, and it was in
             * the shared primitive rather than in any screen, which is why it
             * appeared on five screens at once.
             */
            <View key={i} style={[styles.rowItem, roomy ? styles.rowItemWide : null]}>
              {child}
            </View>
          ) : null,
        )}
      </View>
    </RowCellContext.Provider>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  // secondary, not muted: an empty-state message conveys information.
  return <Text style={styles.empty}>{children}</Text>;
}

/**
 * A destructive action that TAKES OVER while it is being confirmed.
 *
 * `children` are the card's normal actions. While the confirm is open they are
 * not rendered at all — which is the whole point. The first version of this was
 * hand-rolled twice and simply appended the warning BELOW the live buttons, so
 * during "permanently delete this?" the Listen/Publish/Back-to-draft row stayed
 * tappable and two red panels stacked. A confirmation that leaves the thing it
 * is guarding still operable is not a confirmation.
 *
 * Owns its own open state so a caller cannot forget to reset it, and renders
 * nothing at all when `enabled` is false (e.g. a published recording, which must
 * be unpublished first).
 */
export function ConfirmDanger({
  enabled = true,
  label,
  confirmLabel,
  warning,
  busy,
  onConfirm,
  testID,
  confirmTestID,
  opened,
  children,
}: {
  enabled?: boolean;
  /** The button that opens the confirm. */
  label: string;
  /** The button that performs it. */
  confirmLabel: string;
  warning: string;
  busy?: boolean;
  onConfirm: () => void;
  testID?: string;
  confirmTestID?: string;
  /**
   * OPENED FROM ELSEWHERE — a menu's Delete — instead of from a button of its
   * own: whether it is open, and how it closes. Without it, the confirm owns
   * that state and draws its button.
   */
  opened?: { open: boolean; close: () => void };
  /** The actions this replaces while confirming. */
  children?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = opened ? opened.open : ownOpen;
  const close = opened ? opened.close : () => setOwnOpen(false);
  const closeNow = useRef(close);
  closeNow.current = close;

  // If the underlying thing stops being deletable while the confirm is open
  // (someone else published it), close it — otherwise the stale `open` would
  // spring the confirm back the moment it became deletable again.
  useEffect(() => {
    if (!enabled && open) closeNow.current();
  }, [enabled, open]);

  if (!enabled) return <>{children}</>;

  if (open) {
    return (
      <View style={styles.confirm}>
        <Notice tone="error">{warning}</Notice>
        <Row>
          <Button
            testID={confirmTestID}
            label={confirmLabel}
            variant="danger"
            busy={busy}
            onPress={onConfirm}
          />
          {/* Quiet everywhere Cancel appears — a sheet's dismiss, an inline
              editor's, a confirmation's. Filled sage, it was the most legible
              control on a card whose primary is correctly disabled until a
              reason is typed. */}
          <Button label="Cancel" variant="quiet" disabled={busy} onPress={close} />
        </Row>
      </View>
    );
  }

  return (
    <>
      {children}
      {opened ? null : (
        <View style={styles.dangerZone}>
          <Button testID={testID} label={label} variant="danger" onPress={() => setOwnOpen(true)} />
        </View>
      )}
    </>
  );
}

/**
 * A section that starts closed — for rows that must remain reachable without
 * being in the way: archived cohorts, disabled students.
 *
 * Closed content is UNMOUNTED, not hidden. Height-zero content still matches a
 * query and then swallows the click that was meant for whatever is drawn over
 * it, and the e2e drives these screens by testID — an unmounted section fails
 * honestly (the locator never resolves) instead of clicking something invisible.
 *
 * `aria-expanded`, not `accessibilityState`: react-native-web has no mapping for
 * accessibilityState, so it reaches the DOM as nothing at all and the control
 * announces no state. RN supports the aria props natively (see the manager
 * checkbox in CourseDetailScreen for the same fix).
 */
export function Collapsible({
  title,
  count,
  testID,
  children,
}: {
  title: string;
  count?: number;
  testID?: string;
  children: ReactNode;
}) {
  // Always starts closed. A `defaultOpen` prop went in with no caller, which is
  // the speculative infrastructure this repo keeps out on purpose.
  const [open, setOpen] = useState(false);
  const label = count === undefined ? title : `${title} (${count})`;
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={`${open ? 'Hide' : 'Show'} ${label}`}
        onPress={() => setOpen((v) => !v)}
        style={styles.collapseHead}
      >
        {/* The icon set the rest of the app draws with, not a text glyph. A
            literal ▸ is the only place a typed shape stood in for an icon, and
            it renders at whatever weight the platform font gives it — beside a
            Material bar and Material rail it read as a different vocabulary. */}
        <MaterialIcons
          name={open ? 'expand-more' : 'chevron-right'}
          size={20}
          color={t.text.secondary}
        />
        <Text style={styles.collapseTitle}>{label}</Text>
      </Pressable>
      {open ? children : null}
    </>
  );
}

/**
 * A labelled on/off row — the settings control.
 *
 * NOT React Native's `Switch`. On react-native-web that renders a browser
 * control whose track and thumb colours are only partly reachable from JS, so it
 * arrives on screen in system blue — and this app has a fixed palette and an
 * ESLint rule against stray colours precisely so that cannot happen. Two Views
 * and a transform give the same affordance, identical on both surfaces, in
 * brand colours.
 *
 * The WHOLE ROW is the target, not just the switch: a 52pt pill is a poor tap
 * target on a phone, and everyone expects the label to work.
 *
 * `aria-checked`, not `accessibilityState`: react-native-web has no mapping for
 * accessibilityState, so it reaches the DOM as nothing at all and the control
 * announces no state. RN supports the aria props natively (same fix as the
 * manager checkbox in CourseDetailScreen).
 */
export function SwitchRow({
  label,
  description,
  on,
  onChange,
  testID,
}: {
  label: string;
  description?: string;
  on: boolean;
  onChange: (next: boolean) => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      aria-checked={on}
      accessibilityLabel={label}
      onPress={() => onChange(!on)}
      style={({ pressed }) => [styles.switchRow, pressed ? styles.switchRowPressed : null]}
    >
      <View style={styles.switchText}>
        <Text style={styles.switchLabel}>{label}</Text>
        {description ? <Text style={styles.switchDescription}>{description}</Text> : null}
      </View>
      {/* Decorative: the Pressable above owns the role and the state, so the
          track must not announce itself a second time. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.track, on ? styles.trackOn : null]}
      >
        <View style={[styles.knob, on ? styles.knobOn : null]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: t.bg.canvas },
  content: {
    padding: spacing(5),
    paddingBottom: spacing(12),
    width: '100%',
    alignSelf: 'center',
  },
  contentWide: { paddingHorizontal: spacing(8), paddingTop: spacing(7) },
  // Held still, the content is the screen's height, and its foot needs only a
  // margin: the room a scrolling page leaves to clear the bar is not wanted.
  contentFill: { flex: 1, paddingBottom: spacing(5) },
  headActions: { flexDirection: 'row', gap: spacing(2), alignItems: 'flex-start', flexShrink: 0 },
  h1: { fontSize: 26, fontWeight: '700', color: t.text.primary },
  // Hugs the name rather than spanning the row, so the press target is the
  // words and the chevron, not the empty space beside them.
  h1Link: { alignSelf: 'flex-start' },
  h1LinkPressed: { opacity: 0.6 },
  h1Chevron: { color: t.text.accent, fontWeight: '400' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(3) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing(2) },
  /*
   * 44 TALL, like every other target in the app. A filter pill is a control
   * people tap on a phone, and at 24px two wrapped rows of them sat a
   * finger-width apart. The sweep reports small targets and never fails them,
   * which is how four screens' worth stayed at half size.
   *
   * And carrying the same top margin `styles.btn` does, because on the two
   * ledger screens a Button shares this row. `btn`'s `marginTop` is a COLUMN
   * affordance ("space above me when I follow something"); in a centred row it
   * shifts the button's border box down by half of it, and the toolbar came out
   * four pixels out of true.
   */
  chip: {
    marginTop: spacing(2),
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(4),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.border.strong,
  },
  chipOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
  chipText: { fontSize: 13, fontWeight: '600', color: t.text.secondary },
  chipTextOn: { color: t.accent.onAccent },
  segmented: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    gap: 2,
    padding: 3,
    borderRadius: 9,
    backgroundColor: t.bg.inset,
    marginBottom: spacing(4),
  },
  segment: {
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(4),
    borderRadius: 7,
    // 44, like every other target. This is a two-way switch between the halves
    // of a screen, not a caption.
    minHeight: 44,
    justifyContent: 'center',
  },
  // A RAISED THUMB, and one you can see. The surface fill alone differs from the
  // inset track by a shade, so which half was on came down to reading two
  // near-identical creams; the accent on the label is what makes it legible
  // without turning a view switch into the brand's loudest control.
  segmentOn: { backgroundColor: t.bg.surface, borderWidth: 1, borderColor: t.border.strong },
  segmentPressed: { opacity: 0.7 },
  segmentText: { fontSize: 14, fontWeight: '600', color: t.text.secondary },
  segmentTextOn: { color: t.text.accent, fontWeight: '700' },
  /*
   * `minWidth: 0` IS LOAD-BEARING. A flex item's automatic minimum size is its
   * min-content width, and that beats any width set on it — so at 320px, where
   * one cell is the whole row, a cell grew to whatever its longest unbreakable
   * row needed and pushed its own actions past the right edge. As plain block
   * children, which is what the narrow case used to be, the question never came
   * up; as flex items it has to be answered.
   */
  gridCell: { flexShrink: 0, minWidth: 0 },
  // One card holding the rows: its border and corners, and no gap between rows.
  gridAsRows: {
    gap: 0,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border.subtle,
    overflow: 'hidden',
  },
  rowList: {
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border.subtle,
    overflow: 'hidden',
    marginBottom: spacing(3),
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    minHeight: 52,
    paddingVertical: spacing(3),
    paddingLeft: spacing(4),
    paddingRight: spacing(2),
  },
  navRowPressed: { backgroundColor: t.bg.inset },
  navText: { flex: 1, minWidth: 0 },
  gridRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border.subtle },
  // `flexBasis: '100%'`, not 0. With `flexWrap` a zero basis never fills a line,
  // so every cell landed on the SAME line — thirteen 21px slivers. A full-width
  // basis is what makes one item per line and fills it.
  gridCellFull: { flexGrow: 1, flexBasis: '100%' },
  lede: { fontSize: 15, color: t.text.secondary, marginTop: spacing(1) },
  ledeBlock: { marginTop: spacing(1) },
  ledeText: { fontSize: 15, color: t.text.secondary },
  // Raspberry is the primary action's colour, and this IS the header's action.
  // #83114F on the ivory canvas is far past 4.5:1, so it carries at 15pt.
  ledeLink: { color: t.text.accent, textDecorationLine: 'underline' },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.text.secondary,
    marginTop: spacing(4),
    marginBottom: spacing(2),
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing(3),
    gap: spacing(4),
  },
  switchRowPressed: { opacity: 0.7 },
  switchText: { flex: 1 },
  switchLabel: { fontSize: 15, fontWeight: '600', color: t.text.primary },
  switchDescription: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  track: {
    width: 52,
    height: 32,
    borderRadius: 16,
    backgroundColor: t.bg.inset,
    borderWidth: 1,
    borderColor: t.border.strong,
    padding: 3,
    justifyContent: 'center',
  },
  // Raspberry on, recessed ivory off — the same pair the app uses everywhere for
  // selected vs not, so "on" needs no legend.
  trackOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
  knob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: t.bg.raised,
    // translateX rather than alignSelf: alignSelf jumps, and on web this
    // transitions for free.
    transform: [{ translateX: 0 }],
  },
  knobOn: { transform: [{ translateX: 20 }] },

  // Reads as a SectionTitle that happens to be tappable, so a closed section
  // still looks like part of the page rather than a stray button.
  collapseHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    minHeight: 44,
    marginTop: spacing(4),
    marginBottom: spacing(2),
  },
  collapseTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.text.secondary,
  },
  card: {
    // Fills the grid cell it is given, so a row of these ends level instead
    // of ragged with its actions at three different heights.
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.border.subtle,
    padding: spacing(4),
    marginBottom: spacing(3),
  },
  countsLine: { fontSize: 14, lineHeight: 22, color: t.text.secondary },
  email: { flexDirection: 'row', minWidth: 0, maxWidth: '100%' },
  emailText: { flexShrink: 1, minWidth: 0 },
  emailSuffix: { flexShrink: 0 },
  countsNum: { fontSize: 15, fontWeight: '700', color: t.text.primary },
  countsAlarm: { color: t.text.danger },
  cardInGrid: { marginTop: 0, marginBottom: 0 },
  // A row of the grid's one card: the card's border and corners are the grid's.
  cardAsRow: { borderWidth: 0, borderRadius: 0 },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing(2),
    marginTop: spacing(3),
    marginBottom: spacing(1),
  },
  sectionTitleInRow: { flexShrink: 1, marginTop: 0, marginBottom: 0 },
  btn: {
    borderRadius: 8,
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(4),
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginTop: spacing(2),
  },
  btnWide: { alignSelf: 'flex-start', minWidth: 120 },
  btnPrimary: { backgroundColor: t.accent.base },
  /*
   * FILLS THE CELL `Row` GIVES IT — and only there.
   *
   * Grow, so a pair comes out as two equal halves; shrink, because React Native
   * defaults flexShrink to 0 unlike CSS and growing alone left a 190px button in
   * the 154px cell it shared, its label clipped mid-word and the two controls
   * drawn on top of each other. Shrinking lets the label wrap onto the second
   * line `numberOfLines={2}` already allows.
   *
   * On the button unconditionally, this reached every OTHER row in the app too:
   * an export button beside a segmented control grew to 840px, a slab holding
   * two words and the largest thing on the page.
   */
  btnFill: { flexGrow: 1, flexShrink: 1 },
  btnSecondary: { backgroundColor: t.bg.sage },
  // Unfilled, because weight should follow consequence. A full-width sage
  // Cancel under a content-width primary is the loudest thing in the sheet and
  // it is the one action that does nothing.
  btnQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.border.subtle },
  btnDanger: { backgroundColor: t.feedback.danger },
  btnPressed: { opacity: 0.85 },
  // Neutral rather than a faded brand fill: a washed-out raspberry block still
  // pulls the eye harder than the live control next to it.
  btnDisabled: { backgroundColor: t.bg.inset },
  // Secondary, not muted: muted on the inset fill is 2.3:1, and a disabled
  // primary is the thing a person reads to find out what the form is FOR —
  // "Create account" greyed out is the sheet's own explanation of why nothing
  // has happened yet. The pale fill is what says disabled; the label still has
  // to be readable. (5.1:1.)
  btnDisabledText: { color: t.text.secondary },
  // textAlign, not just the container's alignItems: that centres the text BOX,
  // and a label short enough to fit on one line looks centred either way. The
  // moment it wraps ("Submit / attendance") the second line hangs left inside a
  // box that is itself centred, which reads as a mistake.
  btnText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  btnPrimaryText: { color: t.accent.onAccent },
  btnSecondaryText: { color: t.text.primary },
  btnQuietText: { color: t.text.secondary },
  field: { marginTop: spacing(3) },
  // A single-line field stretched to 1100px is unreadable and looks unfinished;
  // the value in it is a name or an email, never a paragraph.
  fieldWide: { maxWidth: 440 },
  /*
   * GROWS WITH THE NOTE rather than scrolling inside a fixed box.
   *
   * A textarea scrolls its content THROUGH its padding, so however the height is
   * rounded the next line's cap-tops show under the last full one — which reads
   * as a rendering fault rather than as "there is more". Four lines is the
   * floor, `maxHeight` the ceiling for a note nobody should be writing here, and
   * `onContentSizeChange` moves between them.
   */
  inputMultiline: { minHeight: 114, maxHeight: 312, lineHeight: 22, textAlignVertical: 'top' },
  fieldLabel: inputLook.label,
  input: inputLook.box,
  inlineNumber: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), marginTop: spacing(3) },
  inlineNumberText: { fontSize: 15, color: t.text.primary },
  inlineNumberBox: { width: 76, textAlign: 'center' },
  notice: {
    borderRadius: 8,
    padding: spacing(3),
    marginTop: spacing(3),
  },
  noticeText: { fontSize: 14 },
  errorBanner: {
    backgroundColor: t.bg.dangerSoft,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(3),
  },
  errorText: { fontSize: 13, color: t.text.danger },
  // `StatusChip`'s inline tag — a dot and a word inside a list row. Named apart
  // from the filter pills above, which are a control; these are not tappable.
  tag: { flexDirection: 'row', alignItems: 'center' },
  tagDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing(1.5) },
  tagText: { fontSize: 13, color: t.text.secondary },
  row: {
    flexDirection: 'row',
    // `stretch`, so every cell is as tall as the tallest — see `rowItem`, which
    // is what passes that height on to the control inside it.
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
    gap: spacing(2),
    paddingVertical: spacing(1),
  },
  // flexShrink 0 is load-bearing, not a tidy-up: with shrink enabled a line that
  // does not quite fit squeezes its items instead of wrapping, and a squeezed
  // button breaks its label mid-word. Refusing to shrink means the line either
  // fits or wraps — both readable. maxWidth caps the one case shrink used to
  // cover: a basis wider than the container itself, on a very narrow screen.
  /*
   * A ROW, not a column, and that is the whole fix.
   *
   * `alignItems: 'stretch'` on the outer row makes every CELL as tall as the
   * tallest. As a column container the cell then stretched its child's WIDTH
   * and left its height alone, so a button whose label wrapped stayed 58px
   * beside a 44px one — the stretch went to an invisible wrapper and stopped
   * there. As a row container the cross axis is vertical, so the control fills
   * the cell it was given, and `btn`'s own `flexGrow` fills it the other way.
   */
  rowItem: {
    // A row itself, so `alignItems: 'stretch'` has something to stretch: the
    // button is its child, and a column cell would stretch only the invisible
    // wrapper.
    flexDirection: 'row',
    alignItems: 'stretch',
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 150,
    maxWidth: '100%',
  },
  rowItemWide: { flexGrow: 0, flexBasis: 'auto' },

  // --- icon actions -------------------------------------------------
  iconBtn: {
    width: 44,
    height: 44, // minimum touch target, whatever the glyph's size
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnSecondary: { backgroundColor: t.bg.sage },
  iconBtnDanger: { backgroundColor: t.bg.dangerSoft },
  iconBtnBarePressed: { opacity: 0.6 },
  iconBtnBareDisabled: { opacity: 0.4 },
  chipDisabled: { opacity: 0.5 },
  iconGlyph: { fontSize: 20, lineHeight: 24, fontWeight: '700' },
  iconGlyphSecondary: { color: t.text.primary },
  iconGlyphDanger: { color: t.text.danger },

  // --- a person in a list --------------------------------------------------
  // The heading row: the text block on the left, the screen's actions on the
  // right. The status lamp is inside the text block, on the lede line — see
  // `Screen`'s note and `StatusLight`.
  headRow: {
    flexDirection: 'row',
    // The top, so an icon stays with the title's first line when a long name
    // wraps, instead of floating between its lines.
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing(3),
    marginBottom: spacing(4),
  },
  /*
   * THE TITLE GIVES WAY, AND WRAPS BETWEEN ITS WORDS; the icons beside it do
   * not move. They are icons — a plus, a pencil, a ⋮ — 44px each, so even two
   * leave a 320px phone's title 172px, wider than any word in a course or
   * session name. A row that wrapped instead put the pencil on a line of its
   * own under every long title: a wrapping row lays a long title out at its
   * whole one-line width first, which fills the line, and only then shrinks it.
   *
   * `minWidth: 0` is what lets it shrink at all: a flex item keeps its
   * content's width otherwise, and the title would push the icons off the
   * screen. Yoga (Android) gives `flexShrink: 0` to the icons by default, so
   * they keep their size there too.
   */
  headText: { flex: 1, minWidth: 0 },
  light: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    alignSelf: 'flex-start',
    marginTop: spacing(1),
  },
  // Bigger than the chip's 8pt dot — at a page heading this is the thing you
  // look for first.
  lightDot: { width: 12, height: 12, borderRadius: 6 },
  // secondary, not muted: the status word is content, and true taupe is ~2.7:1.
  // No `marginTop` or `textAlign`: those are from the column layout this lamp
  // used to have, and in a row they align the dot and the word to nothing.
  lightText: { fontSize: 11, color: t.text.secondary },
  rowCard: {
    // Fills its grid cell — see the note on `card`.
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  // Wraps rather than squeezes: a long name pushes the actions onto their own
  // line instead of crushing them. The CELL is what never shrinks (`rowItem`);
  // the button inside one does, so its own label can wrap.
  rowHead2: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    // Lines of a wrapped row are packed to the TOP of its minimum height unless
    // told otherwise, which left a blank band under every two-line row.
    alignContent: 'center',
    gap: spacing(2),
    minHeight: 52,
  },
  rowIdent: { flexGrow: 1, flexShrink: 1, flexBasis: 180, gap: 2 },
  // The pinned variant: the name takes the room it needs and wraps within it,
  // while the actions hold their size at the right-hand end, vertically centred.
  rowHeadPinned: { flexWrap: 'nowrap' },
  rowIdentPinned: { flexBasis: 'auto', minWidth: 0 },
  // flexGrow MUST be cancelled, not just shrink: the base row lets the actions
  // grow and centres them inside, which parks a lone icon in mid-air instead of
  // at the edge — and only shows up next to a row whose name is short.
  rowActionsPinned: {
    flexGrow: 0,
    flexShrink: 0,
    justifyContent: 'flex-end',
    alignSelf: 'center',
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing(2),
  },
  rowTitle: { fontSize: 16, fontWeight: '600', color: t.text.primary, flexShrink: 1 },
  // Centred when they wrap to their own line, right-hand end when they share the
  // name's line — one rule that reads correctly in both.
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing(2),
    flexGrow: 1,
    flexBasis: 'auto',
  },
  // secondary, not muted: an email address is content someone reads, and true
  // taupe on ivory is ~2.7:1 — reserved for text you could delete without
  // losing anything.
  rowDetail: { fontSize: 13, color: t.text.secondary },
  empty: { fontSize: 14, color: t.text.secondary, paddingVertical: spacing(3) },
  // Separated from the actions above it, so a destructive button is never the
  // one you hit by muscle memory.
  dangerZone: {
    marginTop: spacing(4),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: t.border.subtle,
  },
  confirm: { gap: spacing(2) },
});
