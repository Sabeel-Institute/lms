import * as DocumentPicker from 'expo-document-picker';
import { createVideoPlayer } from 'expo-video';

/**
 * Native side of the audio-picker seam (web sibling: filePicker.web.ts).
 *
 * Uploading from a phone is supported: expo-document-picker opens the system file
 * browser, the file is read into a Blob for the same signed upload the web uses,
 * and its duration is read with the player engine (expo-video) so a phone
 * upload stores the SAME
 * `durationSec` a computer upload does. That matters: the player's scrubber,
 * remaining time and listened-% bar all read the stored duration, so a null one
 * would leave a phone-made recording playable but with a broken transport.
 *
 * (Autolinked; a native rebuild is needed after adding it, but no config plugin
 * so no prebuild.)
 */
export interface PickedAudio {
  blob: Blob;
  /** Advisory; null if it could not be read. Feeds the stored durationSec. */
  durationSec: number | null;
}

export const canPickAudio = true;

export async function pickAudioFile(): Promise<PickedAudio | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = res.canceled ? null : res.assets?.[0];
  if (!asset) return null; // user backed out
  const durationSec = await readDuration(asset.uri);
  const blob = await (await fetch(asset.uri)).blob();
  // Some pickers hand back a typeless blob; carry the picker's mime type so the
  // upload signs the right contentType instead of octet-stream.
  const typed =
    asset.mimeType && (!blob.type || blob.type === 'application/octet-stream')
      ? blob.slice(0, blob.size, asset.mimeType)
      : blob;
  return { blob: typed, durationSec };
}

/**
 * Read the file's duration by loading it once in a player and taking it when
 * the source is ready (a local file loads in well under a second). Resolves
 * null — never throws — on anything odd, so a bad read does not block the
 * upload; the value is advisory.
 */
function readDuration(uri: string): Promise<number | null> {
  return new Promise((resolve) => {
    const player = createVideoPlayer({ uri });
    let settled = false;
    const ok = (d: number) => (Number.isFinite(d) && d > 0 ? Math.round(d) : null);
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      sub.remove();
      clearTimeout(timer);
      player.release();
      resolve(v);
    };
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay') finish(ok(player.duration));
      else if (status === 'error') finish(null);
    });
    // Fallback: if the source never said it was ready, read what is there before giving up.
    const timer = setTimeout(() => finish(ok(player.duration)), 4000);
  });
}
