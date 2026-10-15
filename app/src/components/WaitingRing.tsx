import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { TURN_MS, ringLook } from './ringLook';

/**
 * A ring turning round a play button while its file is on its way (web
 * sibling: WaitingRing.web.tsx). Turned on the native driver, so no frame of
 * it runs JavaScript.
 */
export function WaitingRing({ size, testID }: { size: number; testID?: string }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: TURN_MS, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View testID={testID} pointerEvents="none" style={[ringLook(size), { transform: [{ rotate }] }]} />;
}
