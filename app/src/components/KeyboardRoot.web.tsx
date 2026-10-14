import type { ReactNode } from 'react';

/**
 * Web side of the keyboard seam (native sibling: KeyboardRoot.tsx). A browser
 * moves the page for its own keyboard, and react-native-keyboard-controller has
 * no web implementation: imported here it brought every component it has, and
 * with them all of Reanimated, 22% of the web bundle, downloaded and run on
 * every load to wrap the app in a provider that did nothing.
 */
export function KeyboardRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
