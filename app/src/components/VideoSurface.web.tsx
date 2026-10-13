import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { currentVideoElement } from '../player.web';
import { Button } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The picture of the file being played, when it is a video (native sibling:
 * VideoSurface.tsx).
 *
 * The `<video>` element belongs to the playback session (player.web.ts); this
 * view borrows it, moving it into the page while the player screen is open.
 * Taking it out again on leaving does not stop it — a playing element outside
 * the document plays on — so the docked bar keeps the sound, as on a phone.
 */
export function VideoSurface() {
  const host = useRef<View>(null);
  const el = currentVideoElement();
  useEffect(() => {
    const box = host.current as unknown as HTMLElement | null;
    if (!el || !box) return;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    el.style.borderRadius = '8px';
    box.appendChild(el);
    return () => {
      if (el.parentElement === box) box.removeChild(el);
    };
  }, [el]);
  if (!el) return null;
  return (
    <View>
      <View ref={host} testID="player-video" style={styles.video} />
      <View style={styles.actions}>
        <Button
          testID="player-fullscreen"
          label="Full screen"
          variant="quiet"
          hug
          onPress={() => void el.requestFullscreen?.()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: t.bg.video, borderRadius: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: spacing(2) },
});
