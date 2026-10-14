/**
 * What an MP4 says of itself that the tag parser does not: the movie's own
 * length, from its movie header (`mvhd`), and each H.264 track's profile,
 * from its decoder configuration (`avcC`).
 *
 * The tag parser takes a file's length from its sound track, so a video with
 * no sound had none and was refused, and a sound track shorter than the
 * picture shortened the file. And to it H.264 is H.264, whatever the profile:
 * a 10-bit or 4:4:4 file passed, played on a computer, and failed on the
 * phones students use.
 *
 * Read a few ranges at a time, never the media: the top-level boxes are
 * walked to the movie box, at the start or the end of the file, which is read
 * in one range and parsed in memory.
 */
export interface Mp4Facts {
  /** The movie header's length in whole seconds; null when it states none (a fragmented file). */
  durationSec: number | null;
  /** Each H.264 track's profile_idc: 66 Baseline, 77 Main, 100 High, 110 High 10, 122 High 4:2:2, 244 High 4:4:4. */
  avcProfiles: number[];
}

/** Bytes `first` to `last`, inclusive, of the file. */
export type ReadRange = (first: number, last: number) => Promise<Uint8Array>;

/** A movie box this large is a very long file's sample tables; it is not read. */
const MOOV_LIMIT = 32 * 2 ** 20;

/** Boxes walked into on the way to the facts; every other box is stepped over. */
const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl']);

/** The facts, or null for a file that is not an MP4 or whose boxes do not add up. */
export async function mp4Facts(read: ReadRange, size: number): Promise<Mp4Facts | null> {
  try {
    let at = 0;
    while (at + 8 <= size) {
      const top = boxAt(await read(at, Math.min(at + 15, size - 1)), 0, size - at);
      if (!top) return null;
      if (top.type === 'moov') {
        if (top.size > MOOV_LIMIT) return null;
        const moov = await read(at, at + top.size - 1);
        return factsIn(moov, top.header, top.size);
      }
      at += top.size;
    }
    return null;
  } catch {
    // A box running past its file, a header cut short: not one to judge by.
    return null;
  }
}

interface Box {
  type: string;
  /** The whole box, header included. */
  size: number;
  header: number;
}

/** The box whose header starts at `at`, with `room` bytes left before its parent ends. */
function boxAt(b: Uint8Array, at: number, room: number): Box | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size32 = view.getUint32(at);
  const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
  const box =
    size32 === 1
      ? { type, size: Number(view.getBigUint64(at + 8)), header: 16 }
      : { type, size: size32 === 0 ? room : size32, header: 8 };
  return box.size >= box.header && box.size <= room ? box : null;
}

function factsIn(moov: Uint8Array, from: number, to: number): Mp4Facts {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const facts: Mp4Facts = { durationSec: null, avcProfiles: [] };

  const children = (start: number, end: number, each: (box: Box, at: number) => void) => {
    let at = start;
    while (at + 8 <= end) {
      const box = boxAt(moov, at, end - at);
      if (!box) return;
      each(box, at);
      at += box.size;
    }
  };

  const walk = (start: number, end: number) =>
    children(start, end, (box, at) => {
      const body = at + box.header;
      if (box.type === 'mvhd') facts.durationSec = movieLength(view, body);
      else if (CONTAINERS.has(box.type)) walk(body, at + box.size);
      // The sample descriptions: a full box's four bytes, a count, then the entries.
      else if (box.type === 'stsd') children(body + 8, at + box.size, sampleEntry);
    });

  // An H.264 entry's fixed fields (78 bytes of a visual sample entry), then
  // its own boxes, the decoder configuration among them; its second byte is
  // the profile.
  const sampleEntry = (entry: Box, at: number) => {
    if (entry.type !== 'avc1' && entry.type !== 'avc3') return;
    children(at + entry.header + 78, at + entry.size, (box, inner) => {
      if (box.type === 'avcC' && box.size >= box.header + 2) facts.avcProfiles.push(moov[inner + box.header + 1]);
    });
  };

  walk(from, to);
  return facts;
}

/** The movie header's length: a full box, then times in 32 bits (version 0) or 64 (version 1). */
function movieLength(view: DataView, body: number): number | null {
  const v1 = view.getUint8(body) === 1;
  const timescale = view.getUint32(body + (v1 ? 20 : 12));
  const duration = v1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
  // All ones is "unknown", which a fragmented file writes.
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return Math.round(duration / timescale);
}
