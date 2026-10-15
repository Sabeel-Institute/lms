/**
 * Firestore's REST encoding, decoded to the plain values the SDKs hand over:
 * for scripts that read the real project with a user token
 * (`CHECK_ACCESS_TOKEN`) because the machine's Application Default
 * Credentials may belong to another Google account.
 */

/** One REST `Value` as the JavaScript value an SDK would give. */
function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  throw new Error(`unknown Firestore value: ${JSON.stringify(v)}`);
}

/** A REST document's `fields` as the object `.data()` would return. */
export const decodeFields = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));

/** A plain value as a REST `Value`, as an SDK would store it. */
export function encodeValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)])) } };
}

/**
 * Every top-level document of a collection, over REST as `token`'s user, a
 * page at a time: `{ id, data, updateTime }`, the last for a write that must
 * not land over a newer one (`currentDocument.updateTime`).
 */
export async function* listDocuments(projectId, collection, token) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}`;
  let pageToken = '';
  for (;;) {
    const r = await fetch(`${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': projectId },
    });
    const out = await r.json();
    if (!r.ok) throw new Error(`${out.error?.status ?? r.status}: ${out.error?.message ?? r.statusText}`);
    for (const d of out.documents ?? []) {
      yield { id: d.name.split('/').pop(), data: decodeFields(d.fields ?? {}), updateTime: d.updateTime };
    }
    if (!out.nextPageToken) return;
    pageToken = out.nextPageToken;
  }
}
