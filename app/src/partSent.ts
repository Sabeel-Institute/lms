/**
 * One PUT of a file or a part, read for its ETag — and when it does not go, a
 * sentence instead of the transport's own words, for both platforms' sendPart.
 *
 * Those words are a Java exception on the phone ("fetch failed:
 * java.net.ConnectException: Failed to connect to …"), "Failed to fetch" in a
 * browser, and "HTTP 403" from a link that ran out. A student whose connection
 * dropped mid-upload read the first off the screen (device pass).
 *
 * A stopped upload is not a failure: the caller stopped it and knows, so its
 * error goes back as it came.
 */
export const SEND_DROPPED = 'The connection dropped while the file was sending. Check your connection, then try again.';
export const SEND_REFUSED = 'The file could not be sent. Try again.';

interface Answer {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

export async function partSent(signal: AbortSignal, put: () => Promise<Answer>): Promise<string> {
  let res: Answer;
  try {
    res = await put();
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn('part did not send', e);
    throw new Error(SEND_DROPPED);
  }
  const etag = res.ok ? res.headers.get('etag') : null;
  if (!etag) {
    console.warn('part refused', res.status);
    throw new Error(SEND_REFUSED);
  }
  return etag;
}
