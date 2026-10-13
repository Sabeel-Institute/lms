import { lazy, Suspense, type ComponentProps } from 'react';
import { ActivityIndicator, Platform, StyleSheet } from 'react-native';

/*
 * THE FORMATTING EDITOR, LOADED WHEN A BOX THAT USES IT OPENS, not with the
 * app. On the web it is Lexical, 130 KB gzipped; a split chunk keeps it out
 * of the first load, which every page of the app pays for.
 *
 * A deploy replaces the chunk's hashed file, so a tab opened before it asks
 * for one that is gone and gets the app's HTML back. That tab is simply out of
 * date: reload it, once — a second failure inside a minute is a real fault and
 * is thrown.
 */
const RELOADED_AT = 'lms-editor-reloaded-at';
const RichEditor = lazy(() =>
  import('./RichEditor').then(
    (m) => ({ default: m.RichEditor }),
    (e: unknown) => {
      if (Platform.OS !== 'web') throw e;
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
        sessionStorage.setItem(RELOADED_AT, String(Date.now()));
      } catch {
        throw e;
      }
      if (Date.now() - last < 60_000) throw e;
      window.location.reload();
      return new Promise<never>(() => {});
    },
  ),
);

export function LazyRichEditor(props: ComponentProps<typeof RichEditor>) {
  return (
    <Suspense fallback={<ActivityIndicator style={styles.loading} />}>
      <RichEditor {...props} />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  // The toolbar and a four-line box, so the form does not jump when it lands.
  loading: { minHeight: 184 },
});
