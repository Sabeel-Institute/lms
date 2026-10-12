import { defineSecret } from 'firebase-functions/params';
import { addDays, zoomRecordingDate } from '@sabeel/shared';
import { putStream } from './mediaStore';

/**
 * Zoom cloud-recording import — the Server-to-Server OAuth client.
 *
 * The three credentials live in Secret Manager and are bound to the Zoom
 * callables; `process.env.ZOOM_*` is populated at runtime only there. Nothing
 * here logs a secret or a token. The network surface is behind `ZoomClient` so
 * the import logic can take a fake in emulator tests (there is no real Zoom in
 * the emulator).
 */
const ZOOM_ACCOUNT_ID = defineSecret('ZOOM_ACCOUNT_ID');
const ZOOM_CLIENT_ID = defineSecret('ZOOM_CLIENT_ID');
const ZOOM_CLIENT_SECRET = defineSecret('ZOOM_CLIENT_SECRET');
export const ZOOM_SECRETS = [ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET];

/** The single central Sabeel Zoom user whose recordings we import (locked decision). */
const ZOOM_SOURCE_EMAIL = 'marketing@oursabeel.com';

/** A meeting that has an audio-only M4A, normalized to what the picker + import need. */
export interface ZoomAudioRecording {
  meetingUuid: string;
  topic: string;
  startTime: string; // ISO 8601 — when the AUDIO began, see `audioSpan`
  durationSec: number;
  fileId: string; // the audio_only M4A file's id
  sizeBytes: number;
}

export interface ZoomClient {
  /**
   * Recordings (with an audio-only M4A) for the source user whose audio began
   * on `fromDate..toDate` inclusive in the INSTITUTE's calendar, newest first.
   */
  listAudioRecordings(fromDate: string, toDate: string): Promise<ZoomAudioRecording[]>;
  /** Re-read one meeting at import time for a FRESH download URL (they expire). */
  freshAudioFile(
    meetingUuid: string,
    fileId: string,
  ): Promise<{ rec: ZoomAudioRecording; downloadUrl: string }>;
  /**
   * Copy the file into the media store at `key`, which must not exist yet
   * (bounded copy — never buffered whole).
   */
  copyToMediaStore(downloadUrl: string, key: string): Promise<void>;
}

// ---- Zoom response shapes (only the fields we read) ----
interface ZoomFile {
  id?: string;
  status?: string;
  recording_type?: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  recording_start?: string;
  recording_end?: string;
  download_url?: string;
}
export interface ZoomMeeting {
  uuid?: string;
  topic?: string;
  start_time?: string;
  duration?: number; // minutes
  recording_files?: ZoomFile[];
}
interface ZoomListResp {
  meetings?: ZoomMeeting[];
  next_page_token?: string;
}

// ---- token, cached in module memory across warm invocations ----
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60_000) return cachedToken.token;
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) throw new Error('Zoom secrets are not configured.');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) throw new Error(`Zoom token mint failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!res.ok) throw new Error(`Zoom API ${res.status} for ${new URL(url).pathname}.`);
  return (await res.json()) as T;
}

/** Pick the audio-only M4A out of a meeting's files, or null if there isn't one. */
function audioFileOf(m: ZoomMeeting): ZoomFile | null {
  const files = m.recording_files ?? [];
  return (
    files.find(
      (f) =>
        (f.status ?? 'completed') === 'completed' &&
        (f.recording_type === 'audio_only' || (f.file_extension ?? f.file_type) === 'M4A'),
    ) ?? null
  );
}

/**
 * When the AUDIO ran: the file's own start and length, which bracket exactly
 * what students will hear — the meeting may have opened minutes before anyone
 * pressed record. Start and length come from the same source, so the end the
 * picker prints (start + length) is the file's end. The meeting's start and
 * whole minutes only when the file does not say.
 */
function audioSpan(f: ZoomFile, m: ZoomMeeting): { startTime: string; durationSec: number } {
  if (f.recording_start && f.recording_end) {
    const d = (Date.parse(f.recording_end) - Date.parse(f.recording_start)) / 1000;
    if (Number.isFinite(d) && d > 0) return { startTime: f.recording_start, durationSec: Math.round(d) };
  }
  return { startTime: m.start_time ?? '', durationSec: Math.round((m.duration ?? 0) * 60) };
}

function toRecording(m: ZoomMeeting, f: ZoomFile): ZoomAudioRecording {
  return {
    meetingUuid: m.uuid ?? '',
    topic: m.topic ?? '',
    ...audioSpan(f, m),
    fileId: f.id ?? '',
    sizeBytes: f.file_size ?? 0,
  };
}

/**
 * A meeting → a normalized audio row, or null if it has no audio-only file.
 * Pure (no network) — the one bit of Zoom-JSON parsing worth unit-testing, since
 * the fake client used in integration tests hands back already-normalized rows.
 *
 * Null too for a recording with no readable start: it has no date, so no range
 * could hold it, and dating it would throw on the whole list.
 */
export function pickAudioRecording(m: ZoomMeeting): ZoomAudioRecording | null {
  const f = audioFileOf(m);
  if (!f) return null;
  const rec = toRecording(m, f);
  return Number.isFinite(Date.parse(rec.startTime)) ? rec : null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * The `from`/`to` pairs to ask Zoom for, covering `fromDate..toDate` INCLUSIVE
 * in windows of at most 30 days — Zoom caps each query at about a month and
 * treats both bounds as inclusive. Pure, so the boundary is testable: a walk
 * written `start < to` asked for nothing at all when staff typed the same day
 * in both fields, which is "today's class", the commonest range there is. An
 * empty range (`from` after `to`) yields no windows.
 */
export function dateWindows(fromDate: string, toDate: string): { from: string; to: string }[] {
  const to = Date.parse(`${toDate}T00:00:00Z`);
  const out: { from: string; to: string }[] = [];
  for (let start = Date.parse(`${fromDate}T00:00:00Z`); start <= to; ) {
    const end = Math.min(to, start + 30 * DAY_MS);
    out.push({ from: ymd(new Date(start)), to: ymd(new Date(end)) });
    start = end + DAY_MS;
  }
  return out;
}

export const zoomClient: ZoomClient = {
  async listAudioRecordings(fromDate, toDate) {
    /*
     * ZOOM'S DATES ARE UTC; STAFF'S ARE HOUSTON'S. An evening class on the 8th
     * is stamped on the 9th in UTC, so asking Zoom for the 8th alone misses it
     * and returns the previous evening's class instead. So ask for one more
     * day, which covers every Houston evening (the institute is behind UTC, never
     * ahead), then keep what began on the requested dates by the institute's
     * calendar. That holds whichever calendar Zoom actually reads them in.
     */
    const byUuid = new Map<string, ZoomAudioRecording>();
    for (const window of dateWindows(fromDate, addDays(toDate, 1))) {
      let pageToken = '';
      do {
        const url = new URL(
          `https://api.zoom.us/v2/users/${encodeURIComponent(ZOOM_SOURCE_EMAIL)}/recordings`,
        );
        url.searchParams.set('from', window.from);
        url.searchParams.set('to', window.to);
        url.searchParams.set('page_size', '300');
        if (pageToken) url.searchParams.set('next_page_token', pageToken);
        const body = await api<ZoomListResp>(url.toString());
        for (const m of body.meetings ?? []) {
          const rec = pickAudioRecording(m);
          if (rec && rec.meetingUuid) byUuid.set(rec.meetingUuid, rec);
        }
        pageToken = body.next_page_token ?? '';
      } while (pageToken);
    }
    return [...byUuid.values()]
      .filter((r) => {
        const date = zoomRecordingDate(r);
        return date >= fromDate && date <= toDate;
      })
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
  },

  async freshAudioFile(meetingUuid, fileId) {
    // A UUID with a leading '/' or an embedded '//' must be DOUBLE url-encoded.
    const encoded = encodeURIComponent(encodeURIComponent(meetingUuid));
    const m = await api<ZoomMeeting>(`https://api.zoom.us/v2/meetings/${encoded}/recordings`);
    const files = m.recording_files ?? [];
    const f = files.find((x) => x.id === fileId) ?? audioFileOf(m);
    if (!f || !f.download_url) throw new Error('That Zoom recording no longer has a downloadable audio file.');
    return { rec: toRecording(m, f), downloadUrl: f.download_url };
  },

  // INTERIM: streams through this Function, which in production bills every
  // byte as Google egress. The Cloudflare Worker copier replaces it before the
  // first deploy (docs/plans/MEDIA-ON-CLOUDFLARE.md, "Zoom import").
  async copyToMediaStore(downloadUrl, key) {
    let res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401) {
      const u = new URL(downloadUrl);
      u.searchParams.set('access_token', await accessToken());
      res = await fetch(u.toString());
    }
    if (!res.ok || !res.body) throw new Error(`Zoom download failed (HTTP ${res.status}).`);
    const size = Number(res.headers.get('content-length'));
    if (!size) throw new Error('Zoom did not say how large the file is.');
    await putStream(key, res.body, size, 'audio/mp4');
  },
};
