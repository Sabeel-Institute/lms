import type { ReactNode } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';

/**
 * The keyboard tracking the app's scroll and sheet seams read on a phone
 * (`KbScroll`, `SheetKeyboard`). Web sibling: KeyboardRoot.web.tsx.
 */
export function KeyboardRoot({ children }: { children: ReactNode }) {
  return <KeyboardProvider>{children}</KeyboardProvider>;
}
