import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/** Web side of the sheet's keyboard seam: a browser's own keyboard resizes the page. */
export function SheetKeyboard({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  return <View style={style}>{children}</View>;
}
