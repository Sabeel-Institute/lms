/**
 * Web side of the audio-picker seam (native sibling: filePicker.ts).
 *
 * A plain file input gives the OS picker for free, and the duration is read from
 * a browser <audio> element. A phone upload reads the same value with the player engine,
 * so a recording's stored `durationSec` is identical whichever device made it —
 * which matters because the player's scrubber, remaining time and listened-%
 * bar all derive from that stored value.
 */
export interface PickedAudio {
  blob: Blob;
  /** Advisory; null if it could not be read. Feeds the stored durationSec. */
  durationSec: number | null;
}

export const canPickAudio = true;

export function pickAudioFile(): Promise<PickedAudio | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.m4a,.mp3,.aac,.wav';
    // Resolving null on cancel rather than never settling: a promise that hangs
    // would leave the button spinning with no way back.
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      if (!file) return resolve(null);
      void readDuration(file).then((durationSec) => resolve({ blob: file, durationSec }));
    });
    input.click();
  });
}

/**
 * Decode just enough of the file to read its duration. Resolves null rather than
 * throwing if the browser cannot read it, so an odd file never blocks an
 * otherwise fine upload.
 */
function readDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    el.addEventListener('loadedmetadata', () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null),
    );
    el.addEventListener('error', () => done(null));
    el.src = url;
  });
}
