import { isVideoContentType, mediaParts, type MediaMap, type UploadContentType } from '@sabeel/shared';

/**
 * Where a chosen file may go: a new part, or a version of a part that has no
 * file of its kind yet, as the server allows (a part with a working file).
 *
 * NUMBERED AS THE FILE LIST NUMBERS THEM, among every part, failed ones too.
 * Numbered among the working parts, a two-stretch import whose first stretch
 * failed offered "Version of Part 1" for the list's Part 2, and the file went
 * on the other stretch of class.
 */
export function placementOptions(media: MediaMap, contentType: UploadContentType | null) {
  const version = contentType && isVideoContentType(contentType) ? 'video' : 'audio';
  const all = Object.values(media);
  const numberOf = new Map(mediaParts(all).map((p, index) => [p.part, index + 1]));
  return [
    { value: 'part', label: 'New part' },
    ...mediaParts(all.filter((i) => i.status !== 'failed'))
      .filter((p) => !p.items.some((i) => i.version === version))
      .map((p) => ({ value: `v${p.part}`, label: `Version of Part ${numberOf.get(p.part)}` })),
  ];
}
