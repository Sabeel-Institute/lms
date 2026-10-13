/** A file staff chose to upload, as either platform describes it. */
export interface PickedFile {
  name: string;
  sizeBytes: number;
  /** A `File` on the web, a URI on a phone: only `mediaFiles` reads it. */
  source: unknown;
}
