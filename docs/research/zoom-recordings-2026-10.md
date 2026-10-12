# Zoom cloud recordings survey, October 2026

A read-only survey of every cloud recording on the Sabeel Zoom user the
import reads from (`marketing@oursabeel.com`), taken 2026-10-12. Sizes come
from Zoom's recording list API; resolutions and bitrates from `ffprobe`
reading each MP4's header over HTTP. No media was downloaded.

The credentials never left Secret Manager and the process that used them; the
survey printed no token, URL or file content.

Rendered summaries: [zoom-video-sizes.html](zoom-video-sizes.html) (the
Quran Immersion classes) and [video-cost-calculator.html](video-cost-calculator.html)
(storage and viewing cost at 1 GB per hour).

## What Zoom stores per meeting

Every recording has some subset of these files. One meeting can produce
**several recordings** when the host stops and restarts recording: each
segment is its own set of files under the same meeting UUID (2026-08-13 Team
Meetings: a 62.5-minute and a 1.5-minute segment; 2026-08-27 Testing: three
segments).

| `recording_type` | `file_type` | What it is |
|---|---|---|
| `shared_screen_with_speaker_view` | MP4 | Shared screen with the active speaker's camera inset, or the camera alone when nothing is shared |
| `shared_screen` | MP4 | The shared screen only; present only when someone shared |
| `audio_only` | M4A | AAC audio, 66–127 kbps |
| `audio_transcript` | VTT | Zoom's transcript |
| `timeline` | JSON | Speaker timeline |
| `chat_file` | TXT | Meeting chat |

Gallery view and active-speaker-only files are absent: the account's cloud
recording settings do not record them.

All video is H.264, 1920×1080 (1920×1200 once, following the shared screen's
aspect), 25 fps. Zoom keeps **one resolution only**; there are no smaller
renditions to download.

## All recordings

| Date (Houston) | Topic | Length | Slides + speaker | Slides only | Audio only |
|---|---|---|---|---|---|
| 2025-07-03 | Extemporaneous Speech Training | 43 min | 91.9 MB (129 MB/h) | – | 40.7 MB |
| 2026-05-07 | Sabeel Institute's Zoom Meeting | 6 s | empty | – | – |
| 2026-08-12 | Testing Zoom Recording for App | 30 s | 0.1 MB | – | 0.1 MB |
| 2026-08-12 | Testing Zoom Recording for App | 17 min | 11.5 MB (40 MB/h) | – | 9.0 MB |
| 2026-08-13 | Hikam Planning meet | 15 min | 15.0 MB (61 MB/h) | – | 9.3 MB |
| 2026-08-13 | Hikam Planning meet | 21 min | 27.7 MB (80 MB/h) | – | 12.9 MB |
| 2026-08-13 | Sabeel Institute Team Meetings | 64 min, 2 segments | 51.2 MB (48 MB/h) | – | 41.6 MB |
| 2026-08-17 | Sabeel Institute Team Meetings | 42 min | 33.4 MB (48 MB/h) | – | 27.2 MB |
| 2026-08-19 | Hikam Planning meet | 2 h 42 min | 152.0 MB (56 MB/h) | – | 91.9 MB |
| 2026-08-20 | Sabeel Institute Team Meetings | 44 min | 36.0 MB (49 MB/h) | – | 27.6 MB |
| 2026-08-27 | Testing Zoom Recording for App | 15 min, 3 segments | 3.6 MB | 2.0 MB | 0.7 MB |
| 2026-08-27 | Sabeel Institute Team Meetings | 44 min | 35.5 MB (48 MB/h) | – | 27.7 MB |
| 2026-09-17 | Quran Immersion Fall | 1 h 54 min | 175.8 MB (92 MB/h) | 112.9 MB | 58.1 MB |
| 2026-09-21 | Mommy Burnout Zoom Meeting | 1 h 28 min | 164.4 MB (112 MB/h) | 79.2 MB | 53.7 MB |
| 2026-09-24 | Quran Immersion Fall | 3 h 07 min | 264.0 MB (85 MB/h) | 182.1 MB | 108.4 MB |
| 2026-09-26 | Personal Meeting Room | 2 h 17 min | 123.5 MB (54 MB/h) | – | 102.0 MB |
| 2026-10-01 | Quran Immersion Fall | 3 h 07 min | 1,155.3 MB (370 MB/h) | 151.3 MB | 98.6 MB |
| 2026-10-08 | Quran Immersion Fall | 2 h 16 min | 228.6 MB (101 MB/h) | 146.5 MB | 79.0 MB |
| 2026-10-08 | Quran Immersion Fall | 56 min | 117.0 MB (126 MB/h) | 53.7 MB | 30.4 MB |
| **Total** | 19 recordings | **22.9 h** | **2.69 GB (118 MB/h)** | **0.73 GB** | **0.82 GB** |

Everything stored, including transcripts and timelines, is about 4.3 GB.

## Findings

- **Size follows what moves on screen, not length.** Slides-only video holds
  at 48–65 MB/h in every class. Slides-plus-speaker ranges 85–370 MB/h in the
  same course on the same settings; the 2026-10-01 outlier is four times its
  neighbours.
- **Video is far below the 15–70× audio ratio** the audio-only invariant was
  written against: slides + speaker was 5.2× the audio overall, slides only
  1.7×. A whiteboard filmed by a camera is the expensive case; planning uses
  1 GB/h, with 1.75 GB/h as the ceiling (Zoom's 3.8 Mbps 1080p send rate plus
  audio).
- **Zoom's audio is ~70 kbps**, not the 32 kbps assumed in
  [firebase-recording-costs.md](firebase-recording-costs.md).
- **Zoom's `download_url` answers with a 302** to a CloudFront-signed URL on
  `ssrweb.zoom.us` (`Policy`, `Signature`, `Key-Pair-Id`). The policy expires
  in 60 minutes, names that one file, is not locked to an IP, needs no other
  credential, and honours `Range` (a 1-byte request returned `206 bytes
  0-0/<size>`). This is what lets a Cloudflare Worker copy a file without any
  Zoom credential leaving Google — see
  [../plans/MEDIA-ON-CLOUDFLARE.md](../plans/MEDIA-ON-CLOUDFLARE.md).
- **Zoom can also issue a meeting-scoped `download_access_token`**
  (`include_fields=download_access_token` on the meeting recordings call);
  confirmed present. The redirect URL is narrower and is the one to use.
- **The import's Zoom app has exactly the scopes it needs:**
  `user:read:user:admin`, `cloud_recording:read:list_user_recordings:admin`,
  `cloud_recording:read:list_recording_files:admin`. It cannot list other
  Zoom users, so recordings made under another host are invisible to it.
- **Zoom's own cloud storage may be near its cap.** If the account is on Zoom
  Pro (5 GB of cloud storage), 4.3 GB is close to full. Deleting a recording
  in Zoom after it is imported would keep it clear; the app does not do that
  today.
