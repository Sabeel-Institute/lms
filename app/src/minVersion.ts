import { Platform } from 'react-native';
import { doc } from 'firebase/firestore';
import { APP_CONFIG_DOC, COLLECTIONS, isBuildOutdated, type AppConfigDoc } from '@sabeel/shared';
import { BUILD_VERSION_CODE } from './buildInfo';
import { db } from './firebase';
import { useLiveDocState } from './liveQuery';
import { read } from './documents';

/**
 * Is this build too old to run?
 *
 * The institute's floor lives in `config/app` and is read live, before anyone
 * signs in — so a build retired while it is open lands on the update screen
 * at once, and one opened after the fact never gets as far as a sign-in the
 * rules would then refuse. The web has no floor: the site serves the current
 * bundle to everyone.
 *
 * NEVER LOCKS ANYONE OUT ON A READ THAT DID NOT ARRIVE. Offline, or before the
 * first snapshot, or with no document at all, the floor is unknown and the app
 * runs: a gate that closed on a network fault would shut out the people it is
 * meant to help. A refusal is treated the same way — the rule opens the
 * document to everyone, so one would be a deploy mistake, not a verdict.
 */
export function useMinVersion(): { outdated: boolean; minVersionCode: number | null } {
  const config = useLiveDocState<AppConfigDoc | null>(
    () => (Platform.OS === 'web' ? null : doc(db, COLLECTIONS.config, APP_CONFIG_DOC)),
    [],
    {
      label: 'appConfig',
      map: (snap) => read('config', snap),
      empty: null,
      denialIsAnswer: true,
    },
  );
  const minVersionCode = config.value?.minVersionCode ?? null;
  return { outdated: isBuildOutdated(BUILD_VERSION_CODE, minVersionCode), minVersionCode };
}
