import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import type { PickedFile } from './mediaFileTypes';
import { PHOTO_QUALITY, PHOTO_WIDTH, photoName } from './photos';
import { opening } from './pickerOpening';

/**
 * Native side of the attachment-file seam (web sibling: attachmentFiles.web.ts):
 * choose documents, pictures or audio, and take a photo with the camera.
 *
 * PHOTOS ARE SHRUNK BEFORE THEY UPLOAD, to about half a megabyte: handwriting
 * stays readable, and a hand-in goes up quickly on a weak signal. The camera's
 * own JPEG is resized here, which also turns anything else into JPEG.
 */
export const canTakePhoto = true;

export async function pickAttachmentFiles(): Promise<PickedFile[] | null> {
  const res = await opening('file browser', () =>
    DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: false }),
  );
  if (res.canceled || !res.assets?.length) return null;
  return res.assets.map((a) => ({ name: a.name, sizeBytes: a.size ?? new File(a.uri).size ?? 0, source: a.uri }));
}

export async function takePhoto(): Promise<PickedFile | null> {
  // WITHOUT THE GRANT, the camera returns as if cancelled, which would read as
  // a button that does nothing.
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('The camera is not allowed for this app. Allow it in the phone’s settings, then try again.');
  }
  const res = await opening('camera', () => ImagePicker.launchCameraAsync({ quality: 1 }));
  const asset = res.canceled ? null : res.assets?.[0];
  if (!asset) return null;
  const context = ImageManipulator.manipulate(asset.uri);
  if (asset.width > PHOTO_WIDTH) context.resize({ width: PHOTO_WIDTH });
  const shrunk = await (await context.renderAsync()).saveAsync({ compress: PHOTO_QUALITY, format: SaveFormat.JPEG });
  return { name: photoName(), sizeBytes: new File(shrunk.uri).size ?? 0, source: shrunk.uri };
}
