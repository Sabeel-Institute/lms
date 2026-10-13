/** Photos are shrunk to this width before upload: handwriting stays readable at about half a megabyte. */
export const PHOTO_WIDTH = 1600;
export const PHOTO_QUALITY = 0.7;

/** A taken photo's name, by the moment it was taken. */
export function photoName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Photo ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.jpg`;
}
