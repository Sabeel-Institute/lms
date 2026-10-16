/**
 * A composed message read back the way a mail program reads it: the header
 * block unfolded, by lower-case name; and each body part, its own headers and
 * its base64 decoded. One reader for every test that looks at an email, so
 * each of them reads it the same way.
 */

export interface MessagePart {
  headers: Map<string, string>;
  /** The decoded content, UTF-8. */
  body: string;
}

function headerBlock(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    if (!line) continue;
    const at = line.indexOf(':');
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

function part(text: string): MessagePart {
  const split = text.indexOf('\r\n\r\n');
  const headers = headerBlock(text.slice(0, split));
  if (headers.get('content-transfer-encoding') !== 'base64') throw new Error('a part not in base64');
  return { headers, body: Buffer.from(text.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

export function parseMessage(raw: string) {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split);
  const headers = headerBlock(head);
  const boundary = /^multipart\/alternative; boundary="([^"]+)"$/.exec(headers.get('content-type') ?? '')?.[1];
  const parts = boundary
    ? raw
        .slice(split + 4)
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((p) => part(p.replace(/^\r\n/, '').replace(/\r\n$/, '')))
    : [part(raw)];
  const of = (type: string) => parts.find((p) => p.headers.get('content-type') === `${type}; charset=UTF-8`)?.body;
  return { head, headers, boundary, parts, text: of('text/plain'), html: of('text/html') };
}
