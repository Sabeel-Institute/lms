import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

/**
 * Native side of the sheet's keyboard seam (web sibling: SheetKeyboard.web.tsx).
 *
 * A sheet is a Modal, and under edge-to-edge Android the keyboard OVERLAYS it:
 * the panel stayed centred on the whole screen, so the foot of a tall sheet —
 * the override form's Cancel — sat under the keys. This gives the panel only
 * the room above the keyboard to centre in; the sheet's own height cap then
 * applies to that room, and its body scrolls. `react-native-keyboard-controller`
 * watches Modals for the IME, which React Native's own events do not.
 */
export function SheetKeyboard({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={style}>
      {children}
    </KeyboardAvoidingView>
  );
}
