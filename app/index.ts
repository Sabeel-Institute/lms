import { registerRootComponent } from 'expo';
import { LogBox } from 'react-native';
import { initSentry } from './src/sentry';
import App from './App';

// Before the app renders, so an error during startup is still captured. The seam
// resolves per platform and is a no-op in dev bundles and when no DSN is set.
initSentry();

// The native flows (scripts/native-e2e.sh) start Metro with EXPO_PUBLIC_E2E=1:
// a debug build's warning toast sits over the tab bar and takes their taps. The
// warnings still reach Metro's log, which the flows keep.
if (__DEV__ && process.env.EXPO_PUBLIC_E2E === '1') LogBox.ignoreAllLogs();

registerRootComponent(App);
