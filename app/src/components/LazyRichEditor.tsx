/*
 * THE FORMATTING EDITOR, WITH THE APP. Only the web loads it on demand
 * (LazyRichEditor.web.tsx): an installed app is one bundle — a release build
 * never splits it — so a lazy load here would buy nothing but a frame of
 * spinner. In a debug build it costs more: the chunk comes from Metro, and
 * once Metro's connection has dropped (the app sat in the background) Expo's
 * dev client answers a chunk load by reloading through `window.location`,
 * which native does not have, and the screen crashes.
 */
export { RichEditor as LazyRichEditor } from './RichEditor';
