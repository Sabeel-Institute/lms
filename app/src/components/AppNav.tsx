import { type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Role } from '@sabeel/shared';
import { RAIL_WIDTH, getTheme, spacing } from '../theme';
import type { RootStackParamList } from '../nav';

const t = getTheme();
type IconName = ComponentProps<typeof MaterialIcons>['name'];
type RouteName = keyof RootStackParamList;

type Tab = {
  key: string;
  label: string;
  icon: IconName;
  /** Where the tab goes. Resolved per role — an admin's "Courses" is the cohort
   *  list, a manager's is the courses they were assigned. */
  route: RouteName;
  /** Routes that show this tab as the active one. A session is "under" Courses. */
  activeFor: RouteName[];
};

/**
 * THE DESTINATIONS THAT EARN A PERMANENT SLOT.
 *
 * Four for staff and two for students, plus More. The rule for what belongs
 * here is that it is somewhere you GO, repeatedly — which is why notification
 * preferences are not on it: a screen visited twice in an account's life does
 * not deserve a permanent slot, however often it gets proposed for one.
 *
 * THE SET DOES NOT CHANGE WITH ROLE. An admin and a manager see the same four
 * words; what differs is where each one lands. A bar that grows a tab when an
 * admin signs in makes the manager's app read as a stripped-down copy of a
 * fuller one, and on a shared device it moves every other tab sideways under
 * the person's thumb.
 */
const STUDENT_TABS: Tab[] = [
  {
    key: 'recordings',
    label: 'Recordings',
    icon: 'play-circle-outline',
    route: 'Home',
    // The player is under Recordings for a student: it is the only place their
    // recordings are opened from, and a screen where no tab is lit reads as
    // having fallen out of the app.
    activeFor: ['Home', 'Player'],
  },
  {
    key: 'classes',
    label: 'Classes',
    icon: 'school',
    route: 'MyClasses',
    activeFor: ['MyClasses', 'MyClassRecord'],
  },
];

function staffTabs(isAdmin: boolean): Tab[] {
  return [
    {
      key: 'today',
      label: 'Today',
      icon: 'checklist',
      // `Home` IS the first tab: it is the route the bare URL resolves to and
      // the one the app opens on, so pointing the first tab anywhere else would
      // leave the landing screen belonging to no tab.
      route: 'Home',
      activeFor: ['Home'],
    },
    {
      key: 'courses',
      label: 'Courses',
      icon: 'menu-book',
      // The one route that differs by role. A manager has no cohort list — the
      // rules give them no unconstrained course query — so their spine is the
      // courses they were assigned.
      route: isAdmin ? 'Cohorts' : 'MyCourses',
      activeFor: [
        'Cohorts',
        'MyCourses',
        'Courses',
        'CourseDetail',
        'CourseAttendance',
        'Sessions',
        'SessionDetail',
        'ZoomImport',
        'StudentLedger',
      ],
    },
    {
      key: 'library',
      label: 'Library',
      icon: 'library-music',
      route: 'Library',
      // Staff reach the player from the library and from a session; the library
      // is the one that is a tab, so it holds it.
      activeFor: ['Library', 'RecordingLedger', 'Player'],
    },
    {
      key: 'people',
      label: 'People',
      icon: 'people',
      route: 'Students',
      activeFor: ['Students', 'StudentDetail'],
    },
  ];
}

function tabsFor(role: Role): Tab[] {
  return role === 'student' ? STUDENT_TABS : staffTabs(role === 'admin');
}

/**
 * The app's persistent navigation chrome.
 *
 * `bar` on a phone, `rail` on a wide screen — chosen by WIDTH, never platform.
 * Both persist on every screen: the rail because a 76px vertical strip costs
 * horizontal space a wide layout has to spare, and the bar because this app is
 * navigated while something is playing — see the note at its render site in
 * `App.tsx`, which is where that trade is argued.
 */
export function AppNav({
  role,
  variant,
  active,
  blocking,
  onNavigate,
  onOpenMore,
}: {
  role: Role;
  variant: 'bar' | 'rail';
  active: RouteName;
  /**
   * How many things are keeping students locked out — an un-taken register, or
   * a recording taken back after they had it. See `TodayItem.blocking`.
   *
   * The ONLY thing in this app that gets a badge, and it is drawn narrowly on
   * purpose: a count that also included work merely outstanding would be a
   * number that is never zero, and a badge that is never zero is one people
   * learn to ignore.
   */
  blocking: number;
  onNavigate: (route: RouteName, mode: 'tab' | 'push') => void;
  /** Opens the sheet, which the shell owns — see `MoreSheet`. */
  onOpenMore: () => void;
}) {
  const insets = useSafeAreaInsets();
  const rail = variant === 'rail';

  const items = tabsFor(role).map((tab) => (
    <NavItem
      key={tab.key}
      icon={tab.icon}
      label={tab.label}
      rail={rail}
      active={tab.activeFor.includes(active)}
      badge={tab.key === 'today' ? blocking : 0}
      testID={`tab-${tab.key}`}
      onPress={() => onNavigate(tab.route, 'tab')}
    />
  ));

  const more = (
    <NavItem
      icon="more-horiz"
      label="More"
      rail={rail}
      testID="tab-more"
      active={active === 'Notifications' || active === 'Audit' || active === 'Tokens'}
      onPress={onOpenMore}
    />
  );

  if (rail) {
    return (
      <View
        style={[
          styles.rail,
          {
            paddingTop: Math.max(insets.top, spacing(3)),
            paddingBottom: Math.max(insets.bottom, spacing(3)),
            paddingLeft: insets.left,
          },
        ]}
      >
        <View style={styles.railMark}>
          <MaterialIcons name="graphic-eq" size={22} color={t.accent.base} />
        </View>
        <View style={styles.railTabs}>{items}</View>
        {more}
      </View>
    );
  }

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing(2)) }]}>
      {items}
      {more}
    </View>
  );
}

function NavItem({
  icon,
  label,
  active,
  onPress,
  rail,
  badge = 0,
  testID,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onPress: () => void;
  rail: boolean;
  badge?: number;
  testID?: string;
}) {
  // Raspberry is the identity accent, spent on the active destination and
  // nothing else in this bar; everything quiet is taupe (docs/BRAND.md).
  const tint = active ? t.accent.base : t.text.secondary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      /* The badge is a number drawn over an icon, so a screen reader saw nothing
         of it and announced "Today" whether one class was locked out or nine.
         Appended rather than replacing the label, so the name still STARTS with
         the destination — the sweep finds every tab by that prefix. */
      accessibilityLabel={
        badge > 0 ? `${label}, ${badge} blocking access` : label
      }
      /* `aria-current`, and neither `accessibilityState` nor `aria-selected`.
         The first reaches the web DOM as nothing at all — react-native-web has
         no mapping for it — and the second does reach it but is not a supported
         state of `role="button"`, so assistive technology ignores it either way.
         `aria-current="page"` is the attribute a navigation control uses to say
         which destination you are on, which is the one thing this bar has to
         announce. `ui.tsx` records the same reasoning for `aria-expanded` and
         `aria-checked`. */
      aria-current={active ? 'page' : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.item,
        rail ? styles.itemRail : styles.itemBar,
        active ? styles.itemActive : null,
        pressed ? styles.itemPressed : null,
      ]}
    >
      <View>
        <MaterialIcons name={icon} size={24} color={tint} />
        {badge > 0 ? (
          <View testID={`${testID}-badge`} style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    // Surface, not white. BRAND.md: the chrome is ivory like everything else —
    // a pure-white strip against the warm canvas reads as a cool foreign panel,
    // and `raised` is the menu colour.
    backgroundColor: t.bg.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border.strong,
    paddingTop: spacing(2),
    // So the first and last active pills are inset from the screen edges rather
    // than butting against them, at every width.
    paddingHorizontal: spacing(2),
  },
  rail: {
    width: RAIL_WIDTH,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing(1),
    backgroundColor: t.bg.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: t.border.strong,
  },
  railMark: { height: 40, justifyContent: 'center', marginBottom: spacing(2) },
  railTabs: { alignItems: 'center', gap: spacing(1), flex: 1 },
  item: { alignItems: 'center', gap: 2, borderRadius: 10, paddingVertical: spacing(2) },
  // `maxWidth` IS THE FIX, and it caps the touch target with it. A cell that
  // simply took its share of the bar made the active pill a third of a 720px
  // screen — one pink slab flush into the corner — while at 390px it looked
  // right, which is why it survived a phone-only review. The pill and the target
  // are the same box; 120 is as wide as either should get.
  itemBar: { flex: 1, paddingHorizontal: spacing(1), maxWidth: 120, alignSelf: 'center' },
  // NEARLY THE RAIL'S WIDTH, with a sliver of padding: at 62px with 4px each
  // side, "Recordings" clipped to "Recordi…". The sweep's "names every tab in
  // full" check holds this.
  itemRail: { width: RAIL_WIDTH - 6, paddingHorizontal: 2 },
  itemActive: { backgroundColor: t.bg.accentSoft },
  itemPressed: { opacity: 0.6 },
  label: { fontSize: 11, fontWeight: '600' },
  // Danger, not the brand accent: this count is a warning about access being
  // withheld, and raspberry is already doing the "which tab am I on" job two
  // pixels away.
  badge: {
    position: 'absolute',
    top: -5,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.feedback.danger,
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: t.text.inverse },
});
