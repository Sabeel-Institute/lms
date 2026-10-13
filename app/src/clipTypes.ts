/** An attachment's sound, as the small player draws it. Milliseconds, as in playerTypes.ts. */
export interface Clip {
  /** `failed`: the link ran out (they last an hour) or the connection dropped. */
  status: 'loading' | 'ready' | 'failed';
  playing: boolean;
  positionMs: number;
  rate: number;
  /** Play, or pause; from the end, play starts again from the beginning. */
  toggle: () => void;
  seek: (ms: number) => void;
  setRate: (rate: number) => void;
}
