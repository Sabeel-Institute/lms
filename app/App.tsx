import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type LinkingOptions,
  type PathConfigMap,
  type NavigationProp,
  type RouteProp,
  useNavigation,
  useRoute,
  StackActions,
  getActionFromState,
  getStateFromPath,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { APP_NAME, APP_SHORT_NAME, type Role } from '@sabeel/shared';
import { useMinVersion } from './src/minVersion';
import { isReady, useSession } from './src/session';
import { liveDueDate, useMyAssignmentState } from './src/completion';
import { SignInScreen } from './src/screens/SignInScreen';
import { DisabledScreen, PendingScreen, ProvisioningScreen, UpdateScreen } from './src/screens/GateScreens';
import { StaffScreen } from './src/screens/StaffScreen';
import { StudentsScreen } from './src/screens/StudentsScreen';
import { StudentDetailScreen } from './src/screens/StudentDetailScreen';
import { CohortsScreen } from './src/screens/CohortsScreen';
import { CoursesScreen } from './src/screens/CoursesScreen';
import { CourseDetailScreen } from './src/screens/CourseDetailScreen';
import { CourseAttendanceScreen } from './src/screens/CourseAttendanceScreen';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { SessionDetailScreen } from './src/screens/SessionDetailScreen';
import { RecordingLedgerScreen } from './src/screens/RecordingLedgerScreen';
import { StudentLedgerScreen } from './src/screens/StudentLedgerScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { ZoomImportScreen } from './src/screens/ZoomImportScreen';
import { AuditScreen, MyAuditScreen } from './src/screens/AuditScreen';
import { HelpFilmScreen, HelpScreen } from './src/screens/HelpScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { StudentAttendanceScreen } from './src/screens/StudentAttendanceScreen';
import { StudentCoursesScreen } from './src/screens/StudentCoursesScreen';
import { StudentHomeScreen } from './src/screens/StudentHomeScreen';
import { WorkScreen } from './src/screens/WorkScreen';
import { CourseworkListScreen } from './src/screens/CourseworkListScreen';
import { CourseworkEditScreen } from './src/screens/CourseworkEditScreen';
import { CourseworkDetailScreen } from './src/screens/CourseworkDetailScreen';
import { GradeScreen } from './src/screens/GradeScreen';
import { useCourseworkState, useSubmissionState } from './src/coursework';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { MyCoursesScreen } from './src/screens/MyCoursesScreen';
import { TokensScreen } from './src/screens/TokensScreen';
import { CrashScreen } from './src/screens/CrashScreen';
import { USE_EMULATORS } from './src/env';
import { TodayScreen } from './src/screens/TodayScreen';
import { AppNav } from './src/components/AppNav';
import { KeyboardRoot } from './src/components/KeyboardRoot';
import { ScreenBoundary } from './src/components/ScreenBoundary';
import { MoreSheet } from './src/components/MoreSheet';
import { MiniPlayer } from './src/components/MiniPlayer';
import { useWide } from './src/useWidth';
import type { RootStackParamList } from './src/nav';
import { STAFF_PATHS, STUDENT_PATHS } from './src/linkPaths';
import { onPushTap } from './src/pushTaps';
// Note the two senses of "session" in this file: `useSession` above is the AUTH
// session; these resolve the documents a route names.
import { useSessionState } from './src/sessions';
import { useRecordingState } from './src/recordings';
import { useStudent } from './src/students';
import { useCourse, useCourseState } from './src/structure';
import { closePlayback, usePlayback } from './src/playback';
import { useStaffQueue, type TodayQueue } from './src/today';
import { Empty, Screen, ScreenOwnsTopInset, Segmented } from './src/components/ui';
import { getTheme } from './src/theme';

const t = getTheme();
const Stack = createNativeStackNavigator<RootStackParamList>();
type Nav = NavigationProp<RootStackParamList>;

/**
 * The handle the persistent chrome navigates through.
 *
 * The rail and the bar live OUTSIDE `NavigationContainer` — they have to, since
 * on a wide screen the rail is a sibling of the whole navigator, not something
 * drawn inside a screen — so they cannot use `useNavigation`. A container ref is
 * React Navigation's own answer to exactly this case.
 */
const navRef = createNavigationContainerRef<RootStackParamList>();

/**
 * A URL is an ADDRESS, so the two populations cannot share one route table.
 *
 * Before any of these had paths, registering every screen for every role was
 * harmless: a screen was reachable only if the UI offered it, and neither home
 * offers the other's. Giving each screen a path made all of them reachable by
 * anyone signed in — and a browser tab remembers where it was, so the ordinary
 * way to arrive is not a typed URL but a SHARED DEVICE: staff finish on a
 * session page, sign out, a student signs in, and React Navigation restores the
 * path. The student got the staff screen fully rendered — the roster form, the
 * controls — with every query denied underneath, and vice versa a manager landed
 * on the student's "Your recordings". Rules held, so nothing leaked; what
 * shipped was a screen nobody should see and a permission denial per listener on
 * it (Sentry: `myAssignments`, `session`).
 *
 * Registering only what the role may use is what makes that unreachable. A path
 * belonging to the other population then matches no screen, and the container
 * falls back to the initial route — their own home, which is the right answer.
 */
function buildLinking(
  screens: PathConfigMap<RootStackParamList>,
): LinkingOptions<RootStackParamList> {
  return {
    enabled: Platform.OS === 'web',
    prefixes:
      Platform.OS === 'web' && typeof window !== 'undefined' ? [window.location.origin] : [],
    // Nested under the resource they belong to, so a URL reads as a place:
    // /courses/<id>/sessions/<id> rather than a flat list of screen names.
    config: { screens },
  };
}

// Built once, not per render: NavigationContainer treats `linking` as an input
// to its history effects, and a fresh object every render re-runs them.
const STAFF_LINKING = buildLinking(STAFF_PATHS);
const STUDENT_LINKING = buildLinking(STUDENT_PATHS);

/** Otherwise the browser tab reads the route name — "CourseDetail". */
const documentTitle = {
  formatter: (options?: { title?: string }, route?: { name?: string }) =>
    `${options?.title ?? route?.name ?? ''} · ${APP_SHORT_NAME}`,
};

/** Shown while a screen's documents are still resolving from their ids. */
function Loading() {
  return (
    <Screen>
      <Empty>Loading…</Empty>
    </Screen>
  );
}

/**
 * The route's subject does not exist, or the viewer may not read it.
 *
 * Reachable in ordinary use, not just from a stale bookmark: unpublishing a
 * recording revokes a student's access to it, so one sitting on the player is
 * told it is gone rather than left on a spinner.
 */
function NotFound({ what }: { what: string }) {
  return (
    <Screen>
      <Empty>That {what} is not available. It may have been removed.</Empty>
    </Screen>
  );
}

/**
 * Every screen below is KEYED ON ITS SUBJECT.
 *
 * `navigate` to a route already on top updates its params in place rather than
 * pushing, so without a key a screen would carry state belonging to the previous
 * subject: the rename field still holding the old course's name, attendance
 * marks from another session, "password link sent to …" naming someone else. No
 * path does that today — but making every route addressable by URL is what makes
 * same-route-different-subject navigation possible, and this is precisely the
 * class of bug the rest of this work has been about.
 */

/** value ?? still-loading ?? gone — the shape every id-resolving wrapper uses. */
function resolve<T>(state: { value: T | null; resolved: boolean }, what: string) {
  if (state.value) return null;
  return state.resolved ? <NotFound what={what} /> : <Loading />;
}

// Chrome is ivory with a dark title, deliberately not a raspberry app bar —
// a brand-coloured header on every screen puts raspberry far past its share.
const navTheme = {
  dark: false,
  colors: {
    primary: t.accent.base,
    background: t.bg.canvas,
    card: t.bg.canvas,
    text: t.text.primary,
    border: t.border.subtle,
    notification: t.feedback.danger,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium: { fontFamily: 'System', fontWeight: '500' as const },
    bold: { fontFamily: 'System', fontWeight: '700' as const },
    heavy: { fontFamily: 'System', fontWeight: '900' as const },
  },
};

export default function App() {
  const session = useSession();
  // The institute's floor for Android builds, read before anything else: a
  // retired build shows the update screen whether or not anyone is signed in.
  const { outdated } = useMinVersion();

  let content;
  let headerless = true;
  if (outdated) {
    content = <UpdateScreen signedIn={session.phase === 'signedIn'} />;
  } else if (session.phase === 'loading') {
    content = (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={t.accent.base} />
      </View>
    );
  } else if (session.phase === 'signedOut') {
    content = <SignInScreen ended={session.ended} />;
  } else {
    const { user, profile, claims } = session;
    const email = user.email ?? '';
    if (!profile || !claims.role) {
      content = <ProvisioningScreen />;
    } else if (claims.status === 'disabled') {
      content = <DisabledScreen email={email} />;
    } else if (claims.status !== 'active') {
      content = <PendingScreen email={email} />;
    } else if (!isReady(claims, profile)) {
      // The token and the record disagree, for a moment: an approval writes the
      // claims just before the record, and a removal reaches the record before
      // this token refreshes. `useSession` is already polling, and the rules
      // would refuse the screens.
      content = (
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={t.accent.base} />
        </View>
      );
    } else {
      headerless = false;
      const role = claims.role as Role;
      const isAdmin = role === 'admin';
      const isStudent = role === 'student';
      content = (
        <Shell role={role} uid={user.uid} email={email} isAdmin={isAdmin}>
          <Navigator
            linking={isStudent ? STUDENT_LINKING : STAFF_LINKING}
          >
            <Stack.Navigator
              screenOptions={{ headerTintColor: t.text.primary }}
              screenLayout={({ children }) => <ScreenBoundary where="screen">{children}</ScreenBoundary>}
            >
              {/* A PUSHED screen keeps its header, which is the only thing
                  carrying Back. A tab root runs without one — it is never pushed,
                  and its own heading already names it — so `Screen` takes over the
                  status-bar inset there instead. One list decides which is which:
                  `HEADERLESS`, read by `screenOptions` below. */}
              <Stack.Screen name="Home" options={screenOptions('Home', APP_NAME)}>
                {() => <Landing role={role} uid={user.uid} isAdmin={isAdmin} />}
              </Stack.Screen>
              <Stack.Screen name="Notifications" options={screenOptions('Notifications', 'Notifications')}>
                {() => <NotificationsScreen uid={user.uid} isStudent={isStudent} />}
              </Stack.Screen>
              <Stack.Screen name="Help" options={screenOptions('Help', 'Help')}>
                {() => <Help role={role} />}
              </Stack.Screen>
              <Stack.Screen name="HelpFilm" options={screenOptions('HelpFilm', 'Help')}>
                {() => <HelpFilm />}
              </Stack.Screen>
              {/* THE ROLE SPLIT IS THE BOUNDARY, not a tidy-up. A screen registered
                  here is addressable by URL, and a browser tab outlives the person
                  signed into it — see the note on the path tables above. Adding a
                  screen to both arms puts it back within reach of both populations. */}
              {isStudent ? (
                <>
                  <Stack.Screen name="MyClasses" options={screenOptions('MyClasses', 'Your classes')}>
                    {() => <MyClasses uid={user.uid} />}
                  </Stack.Screen>
                  <Stack.Screen name="MyClassRecord" options={screenOptions('MyClassRecord', 'Class')}>
                    {() => <MyClassRecord uid={user.uid} />}
                  </Stack.Screen>
                  <Stack.Screen name="Work" options={screenOptions('Work', 'Assignment')}>
                    {() => <Work uid={user.uid} />}
                  </Stack.Screen>
                </>
              ) : (
                <>
                  <Stack.Screen name="Students" options={screenOptions('Students', 'People')}>
                    {() => <People isAdmin={isAdmin} uid={user.uid} />}
                  </Stack.Screen>
                  <Stack.Screen name="StudentDetail" options={screenOptions('StudentDetail', 'Student')}>
                    {() => <StudentDetail isAdmin={isAdmin} uid={user.uid} />}
                  </Stack.Screen>
                  {/* ADMINS ONLY, and registered rather than merely unlinked —
                      the same treatment `MyCourses` gets below, for the mirror
                      reason. A manager's Courses tab goes to `MyCourses`, so
                      nothing navigates them here; but `/cohorts` is a URL, and
                      for a manager the rules deny the cohorts list outright, so
                      it rendered as a live-data error on a screen that looks
                      like it should have worked. Unregistered, the path matches
                      no screen and falls back to their own home. */}
                  {isAdmin ? (
                    <Stack.Screen name="Cohorts" options={screenOptions('Cohorts', 'Courses')}>
                      {() => <Cohorts />}
                    </Stack.Screen>
                  ) : null}
                  {/* Titled for what the screen IS — one cohort: its settings and the
                      courses inside it. The route keeps its name until the id-param
                      conversion renames routes wholesale. Admin-only for the same
                      reason as Cohorts above: nothing navigates a manager here, but
                      `/cohorts/<id>` is a URL, and its course list is a query the
                      rules refuse a manager — so it rendered rename, archive and
                      "Add a course" under a live-data error band. */}
                  {isAdmin ? (
                    <Stack.Screen name="Courses" options={screenOptions('Courses', 'Cohort')}>
                      {() => <Courses />}
                    </Stack.Screen>
                  ) : null}
                  <Stack.Screen name="CourseDetail" options={screenOptions('CourseDetail', 'Course')}>
                    {() => <CourseDetail isAdmin={isAdmin} uid={user.uid} />}
                  </Stack.Screen>
                  <Stack.Screen name="CourseAttendance" options={screenOptions('CourseAttendance', 'Attendance')}>
                    {() => <CourseAttendance />}
                  </Stack.Screen>
                  <Stack.Screen name="Sessions" options={screenOptions('Sessions', 'Sessions')}>
                    {() => <Sessions />}
                  </Stack.Screen>
                  <Stack.Screen name="Coursework" options={screenOptions('Coursework', 'Assignments')}>
                    {() => <Coursework />}
                  </Stack.Screen>
                  <Stack.Screen name="CourseworkEdit" options={screenOptions('CourseworkEdit', 'Assignment')}>
                    {() => <CourseworkEdit isAdmin={isAdmin} />}
                  </Stack.Screen>
                  <Stack.Screen name="CourseworkDetail" options={screenOptions('CourseworkDetail', 'Assignment')}>
                    {() => <CourseworkDetail />}
                  </Stack.Screen>
                  <Stack.Screen name="Grade" options={screenOptions('Grade', 'Grade')}>
                    {() => <GradeWork />}
                  </Stack.Screen>
                  <Stack.Screen name="SessionDetail" options={screenOptions('SessionDetail', 'Session')}>
                    {() => <SessionDetail isAdmin={isAdmin} />}
                  </Stack.Screen>
                  <Stack.Screen name="RecordingLedger" options={screenOptions('RecordingLedger', 'Progress')}>
                    {() => <RecordingLedger />}
                  </Stack.Screen>
                  <Stack.Screen name="StudentLedger" options={screenOptions('StudentLedger', 'Student progress')}>
                    {() => <StudentLedger />}
                  </Stack.Screen>
                  <Stack.Screen name="Library" options={screenOptions('Library', 'Library')}>
                    {() => <Library uid={user.uid} isAdmin={isAdmin} />}
                  </Stack.Screen>
                  <Stack.Screen name="ZoomImport" options={screenOptions('ZoomImport', 'Import from Zoom')}>
                    {() => <ZoomImport />}
                  </Stack.Screen>
                  {/* REGISTERED FOR BOTH, because one route serves two views:
                      `/audit` with no courseId is the institute-wide history
                      (admins, from More) and `/audit?courseId=…` is one class's
                      (managers, from the course page). Unregistering it for a
                      manager would take their scoped view with it — so the
                      admin-only half is refused inside the screen instead. */}
                  <Stack.Screen name="Audit" options={screenOptions('Audit', 'Audit')}>
                    {() => <Audit isAdmin={isAdmin} />}
                  </Stack.Screen>
                  {/* MANAGERS ONLY, and registered rather than merely unlinked —
                      the same treatment `MyCourses` and `Cohorts` get. An admin's
                      Institute-wide view already contains their own actions, so
                      for them this path would be a narrower copy of a screen they
                      have; unregistered, it falls back to their home. */}
                  {isAdmin ? null : (
                    <Stack.Screen name="MyAudit" options={screenOptions('MyAudit', 'Your actions')}>
                      {() => <MyAudit uid={user.uid} />}
                    </Stack.Screen>
                  )}
                  {/* MANAGERS ONLY, and registered rather than merely unlinked:
                      it is their Courses tab, and it queries `array-contains` on
                      their own uid — so for an admin the same URL would render a
                      permanently empty screen. A path belonging to a role the
                      reader does not have matches no screen and falls back to
                      their own home, which is the right answer. */}
                  {isAdmin ? null : (
                    <Stack.Screen name="MyCourses" options={screenOptions('MyCourses', 'My courses')}>
                      {() => <MyCourses uid={user.uid} />}
                    </Stack.Screen>
                  )}
                  <Stack.Screen
                    name="Tokens"
                    component={TokensScreen}
                    options={screenOptions('Tokens', 'Design tokens')}
                  />
                  {USE_EMULATORS ? (
                    <Stack.Screen name="Crash" component={CrashScreen} options={screenOptions('Crash', 'Crash test')} />
                  ) : null}
                </>
              )}
              {/* Both: staff open the player from the library and from a session. */}
              <Stack.Screen name="Player" options={screenOptions('Player', 'Recording')}>
                {/* KEYED BY RECORDING. Navigating to the player while it is already
                    on the stack re-renders the same `Play` with new params, and
                    for one committed frame its live-doc state is still the
                    previous recording's — resolved-and-gone if that one had been
                    unpublished — while `recordingId` is already the new one, so
                    the "stop the audio when the recording goes away" effect
                    stopped what had just been chosen. A new key is a new instance
                    with fresh, unresolved state. */}
                {({ route }) => (
                  <Play
                    key={(route.params as { recordingId?: string } | undefined)?.recordingId ?? ''}
                    studentUid={isStudent ? user.uid : null}
                  />
                )}
              </Stack.Screen>
            </Stack.Navigator>
          </Navigator>
        </Shell>
      );
    }
  }

  return (
    <SafeAreaProvider>
      <KeyboardRoot>
        <StatusBar style="dark" />
        {headerless ? (
          <SafeAreaView style={styles.root}>
            <ScreenBoundary where="app">{content}</ScreenBoundary>
          </SafeAreaView>
        ) : (
          <View style={styles.root}>
            <ScreenBoundary where="app">{content}</ScreenBoundary>
          </View>
        )}
      </KeyboardRoot>
    </SafeAreaProvider>
  );
}

/**
 * THE PERSISTENT CHROME — everything that stays put while screens come and go.
 *
 * Composition, deliberately, rather than React Navigation's own tab navigator.
 * A tab navigator draws its bar inside each screen, so it can never become a
 * left column — and the rail has to be a SIBLING of the whole stack. The
 * mini-player has the same requirement for a different reason: it outlives
 * every screen, the player included. One layout component that owns the frame
 * and hands the stack a box to render into does both and stays readable.
 *
 * The route name comes from a container-ref listener rather than a hook, because
 * this component is outside the container it is describing.
 */
function Shell({
  role,
  uid,
  email,
  isAdmin,
  children,
}: {
  role: Role;
  uid: string;
  email: string;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const wide = useWide();
  /*
   * THE WORK QUEUE IS SUBSCRIBED HERE, not on the screen that shows it.
   *
   * The Today tab carries a count of the sessions blocking access, and a badge
   * that disagrees with the screen behind it is worse than no badge. One
   * subscription, held above both, makes them the same fact rather than two
   * queries that happen to match. A student subscribes to nothing — see
   * `useStaffQueue`.
   */
  const queue = useStaffQueue(role !== 'student', isAdmin, uid);
  // The NAME only. The chrome needs to know which tab to light and whether the
  // screen owns its own top inset; it has no business knowing a route's subject.
  const [routeName, setRouteName] = useState<keyof RootStackParamList>('Home');

  /*
   * A TAPPED NOTIFICATION OPENS WHAT IT IS ABOUT — the assignment, the
   * recording, the register — not the home screen. The path comes with the
   * message; it is opened through THIS person's route table, so a path to a
   * place they have no screen for is ignored rather than thrown on. A tap
   * that arrives before the navigator is ready — the one that launched the
   * app — waits for it.
   */
  const pendingTap = useRef<string | null>(null);
  const openTap = useCallback(
    (path: string) => {
      if (!navRef.isReady()) {
        pendingTap.current = path;
        return;
      }
      const config = { screens: role === 'student' ? STUDENT_PATHS : STAFF_PATHS };
      const state = getStateFromPath(path, config);
      const action = state ? getActionFromState(state, config) : undefined;
      if (action) navRef.dispatch(action);
    },
    [role],
  );
  const latestOpenTap = useRef(openTap);
  latestOpenTap.current = openTap;
  useEffect(() => onPushTap(openTap), [openTap]);

  const onStateChange = useCallback(() => {
    const current = navRef.getCurrentRoute();
    if (current) setRouteName(current.name as keyof RootStackParamList);
    const tap = pendingTap.current;
    if (tap && navRef.isReady()) {
      pendingTap.current = null;
      latestOpenTap.current(tap);
    }
  }, []);

  /**
   * TABS RESET, MENU ITEMS PUSH — and the difference is not a detail.
   *
   * A tab is a root: switching sections must REPLACE the stack, or Back from
   * Library walks down through every tab visited before it. A More-menu
   * destination is the opposite — it is somewhere you go and come back from, so
   * it has to be pushed or it arrives with no Back and no way home but the bar.
   * Resetting for both was the first version, and the sweep caught it as three
   * screens reporting "no Back in the header".
   */
  const go = useCallback((name: keyof RootStackParamList, mode: 'tab' | 'push') => {
    if (!navRef.isReady()) return;
    if (mode === 'push') {
      (navRef.navigate as (n: string, p?: object) => void)(name);
      return;
    }
    navRef.reset({ index: 0, routes: [{ name } as never] });
  }, []);

  const openPlayer = useCallback((recordingId: string, dueDate: string | null) => {
    if (navRef.isReady()) navRef.navigate('Player', { recordingId, dueDate });
  }, []);

  const [moreOpen, setMoreOpen] = useState(false);
  const nav = (
    <AppNav
      role={role}
      variant={wide ? 'rail' : 'bar'}
      active={routeName}
      blocking={queue.blocking}
      onNavigate={go}
      onOpenMore={() => setMoreOpen(true)}
    />
  );
  // The sheet lives HERE, not in the bar. See `MoreSheet` — it is what lets the
  // bar sit after the content in reading order while the rail sits before it.
  const moreSheet = (
    <MoreSheet
      visible={moreOpen}
      role={role}
      email={email}
      onClose={() => setMoreOpen(false)}
      onNavigate={(route) => {
        setMoreOpen(false);
        go(route, 'push');
      }}
    />
  );

  // The mini-player is redundant on the screen that IS the player — showing a
  // one-line summary of what fills the screen behind it is noise.
  const mini = routeName === 'Player' ? null : <MiniPlayer onOpen={openPlayer} />;

  return (
    <NavStateContext.Provider value={onStateChange}>
      <QueueContext.Provider value={queue}>
        <ScreenOwnsTopInset.Provider value={HEADERLESS.has(routeName)}>
          {/*
            THE CHROME IS ON EVERY SCREEN, not only the tab roots. The sibling kanban
            app hides its bar on the immersive board and the reflex is to copy that;
            it is wrong here, because this app is navigated WHILE SOMETHING IS
            PLAYING, and hiding the bar on the player makes the screen people spend
            the most time on a cul-de-sac they can only leave through Back. Every
            audio app on either store keeps the bar and the now-playing strip
            together. The cost is real and it is the right trade: about 112px of a
            small phone on a tab root, and 56px more where a pushed screen adds its
            header.

            READING ORDER DECIDES WHICH SIDE OF THE CONTENT IT SITS ON. A left rail
            belongs before the content and a bottom bar after it — that is what a
            screen reader and the Tab key follow, and CSS reordering does not move
            either. So the two cases genuinely are two orders, rather than one order
            flipped visually. Nothing is lost by unmounting the bar across the
            breakpoint any more: the only state it held was the More sheet, which
            the shell owns now.
          */}
          <View style={[styles.shell, wide ? styles.shellWide : null]}>
            {wide ? nav : null}
            <View style={styles.stack}>
              {children}
              {mini}
            </View>
            {wide ? null : nav}
          </View>
          {moreSheet}
        </ScreenOwnsTopInset.Provider>
      </QueueContext.Provider>
    </NavStateContext.Provider>
  );
}

/**
 * The work queue, reaching the screens inside the navigator.
 *
 * A prop would have to be threaded through the navigator's render callbacks,
 * which are written where the queue is not in scope. This is the same shape as
 * `ScreenOwnsTopInset` next door and for the same reason: one fact the shell
 * knows and one screen inside it needs.
 */
const QueueContext = createContext<TodayQueue>({
  items: [],
  blocking: 0,
  loading: true,
  failed: false,
  scoped: false,
  allFinished: false,
  truncated: false,
});

/**
 * THE TAB ROOTS RUN WITHOUT A STACK HEADER.
 *
 * A header exists to carry Back and to name where you are. A tab root is never
 * pushed, so it has no Back, and it already names itself in its own heading —
 * so the header was drawing "Your classes" in a 56px bar directly above a
 * screen whose first line said "Your classes". On a phone that is a tenth of
 * the viewport spent on a duplicate.
 *
 * The header was ALSO providing the status-bar inset, which is why hiding it
 * naively put the title under the clock. `Screen` takes that over through the
 * context above, on exactly the screens that lose the header.
 *
 * Pushed screens keep theirs: there the header is the only thing carrying Back.
 */
const HEADERLESS = new Set<keyof RootStackParamList>([
  'Home',
  'Cohorts',
  'MyCourses',
  'Students',
  'Library',
  'MyClasses',
]);

/**
 * Every screen's options, with `headerShown` DERIVED from `HEADERLESS` rather
 * than restated beside it.
 *
 * The set and the flags were two copies of the same list, and they drift
 * silently in both directions: a root whose header nobody hid gets a duplicate
 * title and a doubled inset, and one whose inset nobody took over puts its
 * heading under the status bar. One list, consulted once per screen.
 */
function screenOptions(name: keyof RootStackParamList, title: string) {
  return { title, headerShown: !HEADERLESS.has(name) } as const;
}

/** Lets the NavigationContainer report state changes up to the Shell above it. */
const NavStateContext = createContext<() => void>(() => {});

/**
 * The container, split out only so it can read the Shell's callback out of
 * context — a provider cannot consume its own value.
 */
function Navigator({
  linking,
  children,
}: {
  linking: LinkingOptions<RootStackParamList>;
  children: ReactNode;
}) {
  const onStateChange = useContext(NavStateContext);
  return (
    <NavigationContainer
      ref={navRef}
      theme={navTheme}
      linking={linking}
      documentTitle={documentTitle}
      onReady={onStateChange}
      onStateChange={onStateChange}
    >
      {children}
    </NavigationContainer>
  );
}

/**
 * What the bare URL resolves to, per population and per design.
 *
 * There is no hub screen any more. The old one was a page of buttons whose only
 * job was to reach the other screens, which is precisely the job the persistent
 * bar now does — keeping both would mean two competing menus and a landing
 * screen that says nothing about the work.
 *
 * So `Home` is simply THE FIRST TAB: their own listening for a student, and the
 * work queue for staff.
 */
function Landing({ role, uid, isAdmin }: { role: Role; uid: string; isAdmin: boolean }) {
  const navigation = useNavigation<Nav>();
  const queue = useContext(QueueContext);
  if (role === 'student') {
    return (
      <StudentHomeScreen
        uid={uid}
        // The student's OWN deadline, not the session's: it is the day their
        // access closes, so the player has to be able to say so.
        onOpenRecording={(recording, _cls, dueDate) =>
          navigation.navigate('Player', { recordingId: recording.id, dueDate })
        }
        onOpenWork={(courseworkId) => navigation.navigate('Work', { courseworkId })}
      />
    );
  }
  return (
    <TodayScreen
      uid={uid}
      isAdmin={isAdmin}
      queue={queue}
      onOpenSession={(sessionId, courseId) =>
        navigation.navigate('SessionDetail', { sessionId, courseId })
      }
      onOpenLedger={(recordingId) => navigation.navigate('RecordingLedger', { recordingId })}
      onOpenCoursework={(courseId, courseworkId) => navigation.navigate('CourseworkDetail', { courseId, courseworkId })}
    />
  );
}

function Cohorts() {
  const navigation = useNavigation<Nav>();
  return (
    <CohortsScreen onOpen={(cohort) => navigation.navigate('Courses', { cohortId: cohort.id })} />
  );
}

/**
 * THE PEOPLE TAB — one destination, two lists.
 *
 * Students and staff are the same job (who is in this institute, and what may
 * they reach) done for two populations, and an admin visits either a handful of
 * times a term. Two permanent tabs for that would push a daily destination off
 * the bar; a segmented switch costs nothing and keeps both one tap away.
 *
 * A manager sees no switch at all: they have no staff arm in the rules, so for
 * them People simply IS the student list, with no control implying otherwise.
 */
function People({ isAdmin, uid }: { isAdmin: boolean; uid: string }) {
  const navigation = useNavigation<Nav>();
  const [side, setSide] = useState<'students' | 'staff'>('students');
  const header = isAdmin ? (
    <Segmented
      value={side}
      options={[
        { value: 'students' as const, label: 'Students' },
        { value: 'staff' as const, label: 'Staff' },
      ]}
      onChange={setSide}
    />
  ) : null;
  if (isAdmin && side === 'staff') return <StaffScreen selfUid={uid} header={header} />;
  return (
    <StudentsScreen
      isAdmin={isAdmin}
      uid={uid}
      header={header}
      onOpenStudent={(studentUid) => navigation.navigate('StudentDetail', { studentUid })}
    />
  );
}

function StudentDetail({ isAdmin, uid }: { isAdmin: boolean; uid: string }) {
  const navigation = useNavigation<Nav>();
  const { studentUid } = useRoute<RouteProp<RootStackParamList, 'StudentDetail'>>().params;
  return (
    <StudentDetailScreen
      key={studentUid}
      studentUid={studentUid}
      isAdmin={isAdmin}
      uid={uid}
      onOpenCourse={(cls) => navigation.navigate('StudentLedger', { studentUid, courseId: cls.id })}
    />
  );
}

function Courses() {
  const navigation = useNavigation<Nav>();
  const { cohortId } = useRoute<RouteProp<RootStackParamList, 'Courses'>>().params;
  return (
    <CoursesScreen
      key={cohortId}
      cohortId={cohortId}
      onOpen={(cls) => navigation.navigate('CourseDetail', { courseId: cls.id })}
    />
  );
}

function CourseDetail({ isAdmin, uid }: { isAdmin: boolean; uid: string }) {
  const navigation = useNavigation<Nav>();
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'CourseDetail'>>().params;
  const cls = useCourseState(courseId);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <CourseDetailScreen
      key={courseId}
      cls={cls.value}
      isAdmin={isAdmin}
      uid={uid}
      onOpenSessions={() => navigation.navigate('Sessions', { courseId })}
      onOpenCoursework={() => navigation.navigate('Coursework', { courseId })}
      onOpenAttendance={() => navigation.navigate('CourseAttendance', { courseId })}
      onOpenStudent={(studentUid) => navigation.navigate('StudentLedger', { studentUid, courseId })}
      onOpenAudit={() => navigation.navigate('Audit', { courseId })}
    />
  );
}

function CourseAttendance() {
  const navigation = useNavigation<Nav>();
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'CourseAttendance'>>().params;
  const cls = useCourseState(courseId);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <CourseAttendanceScreen
      key={courseId}
      cls={cls.value}
      // navigate, not goBack: a screen opened straight from its URL has nothing
      // beneath it, and the course is a destination in its own right either way.
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
      onOpenSession={(sessionId) => navigation.navigate('SessionDetail', { sessionId, courseId })}
      onOpenStudent={(studentUid) => navigation.navigate('StudentLedger', { studentUid, courseId })}
    />
  );
}

function Sessions() {
  const navigation = useNavigation<Nav>();
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'Sessions'>>().params;
  const cls = useCourseState(courseId);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <SessionsScreen
      key={courseId}
      courseId={courseId}
      courseName={cls.value.name}
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
      onOpenSession={(session) =>
        navigation.navigate('SessionDetail', { sessionId: session.id, courseId })
      }
    />
  );
}

/**
 * UP, NOT FORWARD. A parent link — the course named under a screen's title,
 * the assignment above a student's work — goes back to that page when it is
 * already under this one, and opens it fresh only when it is not (arriving
 * from a link or a notification). React Navigation 7's plain `navigate` pushes
 * a second copy instead, and Back from the copy came down again into the
 * screen just left.
 */
function up<N extends 'CourseDetail' | 'Coursework' | 'CourseworkDetail'>(
  navigation: Nav,
  name: N,
  params: RootStackParamList[N],
) {
  (navigation.navigate as (n: N, p: RootStackParamList[N], o: { pop: boolean }) => void)(name, params, { pop: true });
}

function Coursework() {
  const navigation = useNavigation<Nav>();
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'Coursework'>>().params;
  const cls = useCourseState(courseId);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <CourseworkListScreen
      key={courseId}
      cls={cls.value}
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
      onNew={() => navigation.navigate('CourseworkEdit', { courseId })}
      onOpen={(cw) => navigation.navigate('CourseworkDetail', { courseId, courseworkId: cw.id })}
    />
  );
}

function CourseworkEdit({ isAdmin }: { isAdmin: boolean }) {
  const navigation = useNavigation<Nav>();
  const { courseId, courseworkId } = useRoute<RouteProp<RootStackParamList, 'CourseworkEdit'>>().params;
  const cls = useCourseState(courseId);
  const cw = useCourseworkState(courseworkId ?? null);
  if (!cls.value) return resolve(cls, 'course');
  if (courseworkId && !cw.value) return resolve(cw, 'assignment');
  return (
    <CourseworkEditScreen
      key={courseworkId ?? 'new'}
      cls={cls.value}
      existing={cw.value}
      isAdmin={isAdmin}
      onSaved={(id) =>
        // A new one becomes the assignment it now is; an edit goes back to it —
        // or, opened from a link or a reload with nothing under it, to its page.
        courseworkId && navigation.canGoBack()
          ? navigation.goBack()
          : navigation.dispatch(StackActions.replace('CourseworkDetail', { courseId, courseworkId: id }))
      }
      onDeleted={() => up(navigation, 'Coursework', { courseId })}
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
    />
  );
}

function CourseworkDetail() {
  const navigation = useNavigation<Nav>();
  const { courseId, courseworkId } = useRoute<RouteProp<RootStackParamList, 'CourseworkDetail'>>().params;
  const cls = useCourseState(courseId);
  const cw = useCourseworkState(courseworkId);
  const gate = resolve(cls, 'course') ?? resolve(cw, 'assignment');
  if (gate || !cls.value || !cw.value) return gate;
  return (
    <CourseworkDetailScreen
      key={courseworkId}
      cls={cls.value}
      coursework={cw.value}
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
      onEdit={() => navigation.navigate('CourseworkEdit', { courseId, courseworkId })}
      onGrade={(studentUid) => navigation.navigate('Grade', { courseId, courseworkId, studentUid })}
    />
  );
}

function GradeWork() {
  const navigation = useNavigation<Nav>();
  const { courseId, courseworkId, studentUid } = useRoute<RouteProp<RootStackParamList, 'Grade'>>().params;
  const cls = useCourseState(courseId);
  const cw = useCourseworkState(courseworkId);
  const gate = resolve(cls, 'course') ?? resolve(cw, 'assignment');
  if (gate || !cls.value || !cw.value) return gate;
  return (
    <GradeScreen
      // KEYED BY THE ASSIGNMENT, NOT THE STUDENT: stepping to the next student
      // keeps the screen and its subscriptions (the form inside is keyed per
      // student). Keyed per student, every J or Next tore down and re-made the
      // class's listeners, and showed Loading for two seconds on a phone.
      key={courseworkId}
      cls={cls.value}
      coursework={cw.value}
      studentUid={studentUid}
      // Next REPLACES: walking a class of twenty must not stack twenty screens
      // under the back arrow.
      onOpenStudent={(uid) => navigation.setParams({ studentUid: uid })}
      onBackToList={() => up(navigation, 'CourseworkDetail', { courseId, courseworkId })}
    />
  );
}

function SessionDetail({ isAdmin }: { isAdmin: boolean }) {
  const navigation = useNavigation<Nav>();
  const { sessionId, courseId } = useRoute<RouteProp<RootStackParamList, 'SessionDetail'>>().params;
  const cls = useCourseState(courseId);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <SessionDetailScreen
      key={sessionId}
      sessionId={sessionId}
      cls={cls.value}
      isAdmin={isAdmin}
      onOpenCourse={() => up(navigation, 'CourseDetail', { courseId })}
      onOpenLedger={(recording) =>
        navigation.navigate('RecordingLedger', { recordingId: recording.id })
      }
      onPlay={(recording, s, itemId) =>
        navigation.navigate('Player', { recordingId: recording.id, dueDate: s.dueDate, itemId })
      }
      onImportZoom={(s) => navigation.navigate('ZoomImport', { sessionId: s.id })}
    />
  );
}

function MyClasses({ uid }: { uid: string }) {
  const navigation = useNavigation<Nav>();
  return (
    <StudentCoursesScreen
      uid={uid}
      onOpen={(courseId) => navigation.navigate('MyClassRecord', { courseId })}
    />
  );
}

function MyClassRecord({ uid }: { uid: string }) {
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'MyClassRecord'>>().params;
  const navigation = useNavigation<Nav>();
  const cls = useCourseState(courseId);
  const gate = resolve(cls, 'course');
  if (gate || !cls.value) return gate;
  return (
    <StudentAttendanceScreen
      uid={uid}
      cls={cls.value}
      onOpenWork={(courseworkId) => navigation.navigate('Work', { courseworkId })}
    />
  );
}

/**
 * One assignment for the student it was given to. The assignment, their work
 * on it and the course are all live: a returned grade lands on screen as it
 * is sent, and losing the assignment (left the class, deleted) shows as gone.
 */
function Work({ uid }: { uid: string }) {
  const { courseworkId } = useRoute<RouteProp<RootStackParamList, 'Work'>>().params;
  const coursework = useCourseworkState(courseworkId, true);
  const submission = useSubmissionState(uid, courseworkId);
  const cls = useCourseState(coursework.value?.courseId ?? null);
  const gate = resolve(coursework, 'assignment') ?? resolve(submission, 'assignment') ?? resolve(cls, 'course');
  if (gate || !coursework.value || !submission.value || !cls.value) return gate;
  return (
    <WorkScreen
      key={courseworkId}
      uid={uid}
      coursework={coursework.value}
      submission={submission.value}
      cls={cls.value}
    />
  );
}

function Play({ studentUid }: { studentUid: string | null }) {
  const { recordingId, dueDate: routeDueDate, itemId } =
    useRoute<RouteProp<RootStackParamList, 'Player'>>().params;
  // Chained: the recording names its own course, so the course resolves only
  // once the recording has. Both are live, so an unpublish or an archive lands
  // on screen rather than waiting for the listener to be torn down.
  // For a student a refusal is the recording being withdrawn — unpublished or
  // archived under them — which is the app working, not a listener fault.
  const recording = useRecordingState(recordingId, undefined, studentUid !== null);
  const cls = useCourseState(recording.value?.courseId ?? null);
  // A student's deadline comes from their live grant, not from the date the
  // link was made with — see `useMyAssignmentState`. Staff keep the session's.
  const grant = useMyAssignmentState(studentUid, recordingId);
  const dueDate = liveDueDate(studentUid, grant, routeDueDate ?? null);
  const gone = recording.resolved && !recording.value;
  /*
   * STOP THE AUDIO WHEN THE RECORDING GOES AWAY.
   *
   * Playback outlives this screen now, so unmounting no longer ends it. Unpublish
   * a recording — or archive its course with listening off — while a student is
   * listening and, without this, the screen says it is gone while the audio keeps
   * running off a signed URL good for another twelve hours. The hook version got
   * this for free from its cleanup; the hoisted session has to be told.
   */
  const playing = usePlayback().now?.recordingId;
  useEffect(() => {
    // Only if THIS is what is playing. Opening a stale link to a deleted
    // recording while listening to another one must not stop the other one.
    if (gone && playing === recordingId) void closePlayback();
  }, [gone, playing, recordingId]);
  const gate = resolve(recording, 'recording') ?? resolve(cls, 'course');
  if (gate || !recording.value || !cls.value) return gate;
  return (
    <PlayerScreen
      key={recordingId}
      recording={recording.value}
      cls={cls.value}
      studentUid={studentUid}
      dueDate={dueDate}
      itemId={itemId ?? null}
    />
  );
}

function RecordingLedger() {
  const { recordingId } = useRoute<RouteProp<RootStackParamList, 'RecordingLedger'>>().params;
  const recording = useRecordingState(recordingId);
  const session = useSessionState(recording.value?.sessionId ?? null);
  const cls = useCourseState(recording.value?.courseId ?? null);
  const gate =
    resolve(recording, 'recording') ?? resolve(session, 'session') ?? resolve(cls, 'course');
  if (gate || !recording.value || !session.value || !cls.value) return gate;
  return (
    <RecordingLedgerScreen
      key={recordingId}
      recording={recording.value}
      session={session.value}
      cls={cls.value}
    />
  );
}

function StudentLedger() {
  const navigation = useNavigation<Nav>();
  const { studentUid, courseId } = useRoute<RouteProp<RootStackParamList, 'StudentLedger'>>().params;
  const cls = useCourseState(courseId);
  const student = useStudent(studentUid);
  if (!cls.value) return resolve(cls, 'course');
  return (
    <StudentLedgerScreen
      key={`${studentUid}_${courseId}`}
      studentUid={studentUid}
      // The directory is readable by all staff, so a missing student here means
      // the account is gone rather than out of scope.
      studentName={student?.displayName ?? ''}
      cls={cls.value}
      onOpenStudent={() => navigation.navigate('StudentDetail', { studentUid })}
      onOpenWork={(courseworkId) => navigation.navigate('Grade', { courseId, courseworkId, studentUid })}
    />
  );
}

function ZoomImport() {
  const navigation = useNavigation<Nav>();
  const { sessionId } = useRoute<RouteProp<RootStackParamList, 'ZoomImport'>>().params;
  const session = useSessionState(sessionId);
  const cls = useCourseState(session.value?.courseId ?? null);
  const gate = resolve(session, 'session') ?? resolve(cls, 'course');
  // Locals so the callback below closes over a narrowed value, not a field.
  const sessionDoc = session.value;
  const course = cls.value;
  if (gate || !sessionDoc || !course) return gate;
  return (
    <ZoomImportScreen
      key={sessionId}
      session={sessionDoc}
      cls={course}
      // After importing into this session, return to it (the draft is now there).
      onImported={() =>
        navigation.navigate('SessionDetail', { sessionId, courseId: sessionDoc.courseId })
      }
      // A recording the institute already holds. No due date: staff have none of
      // their own, and this one belongs to somebody else's session anyway.
      onOpenImported={(recordingId) => navigation.navigate('Player', { recordingId, dueDate: null })}
    />
  );
}

function Library({ uid, isAdmin }: { uid: string; isAdmin: boolean }) {
  const navigation = useNavigation<Nav>();
  return (
    <LibraryScreen
      uid={uid}
      isAdmin={isAdmin}
      // The ledger route takes the recording id alone and resolves the session
      // itself, so the library no longer has to fetch one just to navigate.
      onOpenProgress={(recording) =>
        navigation.navigate('RecordingLedger', { recordingId: recording.id })
      }
      onPlay={(recording) => navigation.navigate('Player', { recordingId: recording.id })}
    />
  );
}
function Audit({ isAdmin }: { isAdmin: boolean }) {
  // `?? {}`, and this is the ONE guard for it: React Navigation attaches no
  // params object at all for a path with no parameters in it, so destructuring
  // the result crashes on a cold load of `/audit` — a More-menu destination
  // people land on and reload. Passing `{}` from the navigate call as well
  // covered only the half of the cases that go through it.
  const { courseId } = useRoute<RouteProp<RootStackParamList, 'Audit'>>().params ?? {};
  // The heading is derived rather than passed: a title in the params would ride
  // in the URL's query string, and would be a stale copy of the course's name.
  const cls = useCourse(courseId ?? null);
  return (
    <AuditScreen
      courseId={courseId ?? null}
      allowed={isAdmin || courseId !== undefined}
      title={courseId ? (cls?.name ?? '') : 'All courses'}
    />
  );
}

function Help({ role }: { role: Role }) {
  const navigation = useNavigation<Nav>();
  return (
    <HelpScreen
      role={role === 'student' ? 'student' : role === 'admin' ? 'admin' : 'manager'}
      onOpen={(id) => navigation.navigate('HelpFilm', { id })}
    />
  );
}

function HelpFilm() {
  const { id } = useRoute<RouteProp<RootStackParamList, 'HelpFilm'>>().params;
  return <HelpFilmScreen key={id} id={id} />;
}

function MyAudit({ uid }: { uid: string }) {
  return <MyAuditScreen uid={uid} />;
}

function MyCourses({ uid }: { uid: string }) {
  const navigation = useNavigation<Nav>();
  return (
    <MyCoursesScreen
      uid={uid}
      onOpen={(cls) => navigation.navigate('CourseDetail', { courseId: cls.id })}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg.canvas },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  shell: { flex: 1, flexDirection: 'column', backgroundColor: t.bg.canvas },
  shellWide: { flexDirection: 'row' },
  stack: { flex: 1 },
});
