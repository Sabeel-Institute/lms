import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { TURN_MS, ringLook } from './ringLook';

/**
 * The web's ring (native sibling: WaitingRing.tsx), TURNED BY THE BROWSER: a
 * web animation of `transform`, which the compositor runs off the main
 * thread, as the sliding title's is.
 */
export function WaitingRing({ size, testID }: { size: number; testID?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const animation = ref.current?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: TURN_MS,
      iterations: Infinity,
      easing: 'linear',
    });
    return () => animation?.cancel();
  }, []);
  return <View ref={ref as never} testID={testID} pointerEvents="none" style={ringLook(size)} />;
}
