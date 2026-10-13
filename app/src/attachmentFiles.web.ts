import type { PickedFile } from './mediaFileTypes';
import { PHOTO_QUALITY, PHOTO_WIDTH, photoName } from './photos';

/**
 * Web side of the attachment-file seam (native sibling: attachmentFiles.ts).
 *
 * "Take a photo" is offered only on a touch screen, where the browser opens
 * the camera for an image input with `capture`; on a computer the same input
 * would only open the file chooser a second time.
 */
export const canTakePhoto = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

function choose(accept: string, { multiple, capture }: { multiple: boolean; capture?: boolean }): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    if (capture) input.setAttribute('capture', 'environment');
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      resolve(files.length ? files : null);
    });
    input.click();
  });
}

const toPicked = (f: File): PickedFile => ({ name: f.name, sizeBytes: f.size, source: f });

export async function pickAttachmentFiles(): Promise<PickedFile[] | null> {
  const files = await choose(
    '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,image/jpeg,image/png,image/webp,audio/*,.opus',
    { multiple: true },
  );
  return files?.map(toPicked) ?? null;
}

/** The phone's camera through the browser, shrunk to a JPEG on a canvas. */
export async function takePhoto(): Promise<PickedFile | null> {
  const [photo] = (await choose('image/*', { multiple: false, capture: true })) ?? [];
  if (!photo) return null;
  const bitmap = await createImageBitmap(photo);
  const scale = Math.min(1, PHOTO_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', PHOTO_QUALITY));
  if (!blob) throw new Error('The photo could not be prepared. Try again.');
  return toPicked(new File([blob], photoName(), { type: 'image/jpeg' }));
}
