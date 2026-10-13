import { createElement } from 'react';

/**
 * An attached audio file, played in place (native sibling: AttachmentAudio.tsx):
 * the browser's own audio controls, which carry playback speed.
 */
export function AttachmentAudio({ url }: { url: string }) {
  return createElement('audio', { src: url, controls: true, preload: 'metadata', style: { width: '100%' } });
}
