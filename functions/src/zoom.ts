import { defineSecret } from 'firebase-functions/params';
import {
  addDays,
  meetingListing,
  zoomFileInfo,
  zoomRecordingDate,
  type ZoomFileInfo,
  type ZoomMeeting,
  type ZoomMeetingListing,
} from '@sabeel/shared';
import { copyThroughWorker } from './mediaCopier';

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

export interface ZoomClient {
  /**
   * Meetings of the source user with at least one importable file, whose first
   * segment began on `fromDate..toDate` inclusive in the INSTITUTE's calendar,
   * newest first.
   */
  listMeetings(fromDate: string, toDate: string): Promise<ZoomMeetingListing[]>;
  /**
   * Re-read one file at copy time, with a FRESH download URL (they expire), or
   * null when Zoom no longer has it.
   */
  freshFile(meetingUuid: string, fileId: string): Promise<{ file: ZoomFileInfo; downloadUrl: string } | null>;
  /**
   * Copy the file into the media store at `key`, which must not exist yet.
   * `sizeBytes` is what Zoom's API listed; the copy refuses a file of any
   * other length.
   */
  copyToMediaStore(downloadUrl: string, key: string, sizeBytes: number, contentType: string): Promise<void>;
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
  async listMeetings(fromDate, toDate) {
    /*
     * ZOOM'S DATES ARE UTC; STAFF'S ARE HOUSTON'S. An evening class on the 8th
     * is stamped on the 9th in UTC, so asking Zoom for the 8th alone misses it
     * and returns the previous evening's class instead. So ask for one more
     * day, which covers every Houston evening (the institute is behind UTC, never
     * ahead), then keep what began on the requested dates by the institute's
     * calendar. That holds whichever calendar Zoom actually reads them in.
     */
    const byUuid = new Map<string, ZoomMeetingListing>();
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
          const listing = meetingListing(m);
          if (listing && listing.meetingUuid) byUuid.set(listing.meetingUuid, listing);
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

  async freshFile(meetingUuid, fileId) {
    // A UUID with a leading '/' or an embedded '//' must be DOUBLE url-encoded.
    const encoded = encodeURIComponent(encodeURIComponent(meetingUuid));
    const res = await fetch(`https://api.zoom.us/v2/meetings/${encoded}/recordings`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    // The meeting's recordings deleted in Zoom: the file is gone, which is an
    // answer rather than a failure to retry.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Zoom API ${res.status} for the meeting's recordings.`);
    const m = (await res.json()) as ZoomMeeting;
    const f = (m.recording_files ?? []).find((x) => x.id === fileId);
    const info = f ? zoomFileInfo(m, f) : null;
    if (!f || !info || !f.download_url) return null;
    return { file: info, downloadUrl: f.download_url };
  },

  /*
   * Zoom's `download_url` answers the account's bearer token with a 302 to a
   * self-contained CloudFront link: valid an hour, for this one file, needing
   * no other credential (checked 2026-10-12). Only that link is handed to the
   * Worker, so no Zoom credential leaves Google, and the bytes go from Zoom to
   * Cloudflare without passing through here.
   */
  async copyToMediaStore(downloadUrl, key, sizeBytes, contentType) {
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      redirect: 'manual',
    });
    await res.body?.cancel();
    const link = res.headers.get('location');
    if (res.status !== 302 || !link) {
      throw new Error(`Zoom did not hand over a download link (HTTP ${res.status}).`);
    }
    await copyThroughWorker({ sourceUrl: link, key, size: sizeBytes, contentType });
  },
};
