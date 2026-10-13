#!/usr/bin/env python3
"""Render docs/USER-MANUAL.md → docs/USER-MANUAL.pdf (via Chrome headless).

Run from docs/:  python3 render-manual.py
Keep the PDF committed alongside the source; regenerate both together.

Screenshots come in phone/desktop PAIRS. Author them in the markdown as a raw
HTML block (kept on contiguous lines so python-markdown passes it through):

    <div class="pair">
    <figure class="ph"><img src="manual/img/NAME-phone.png" alt="..."><figcaption>On a phone</figcaption></figure>
    <figure class="wd"><img src="manual/img/NAME-desktop.png" alt="..."><figcaption>On a computer</figcaption></figure>
    </div>
"""
import base64
import datetime
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).parent
import markdown  # python3-markdown

# The app's manifest is the ONLY place the version is written. It was duplicated
# into the cover string here and into the markdown's own version line, so a
# release bumped app.json and shipped a manual still claiming the version before
# it — silently, because a PDF renders perfectly whatever it says.
VERSION = json.loads((HERE.parent / 'app/app.json').read_text())['expo']['version']
DATELINE = datetime.date.today().strftime('%B %Y')

# The app's name has one source too: APP_NAME in the shared constants. The
# logo above it already says "Sabeel Institute", so the cover title is the
# rest of the name.
APP_NAME = re.search(r"export const APP_NAME = '([^']+)'", (HERE.parent / 'packages/shared/src/constants.ts').read_text()).group(1)
COVER_TITLE = APP_NAME.removeprefix('Sabeel Institute ').strip() or APP_NAME

md_text = (HERE / 'USER-MANUAL.md').read_text()

# The markdown states the version too, for anyone reading the source rather than
# the PDF. It cannot be canonical, so it is CHECKED against the manifest instead:
# loud here, at the one moment someone is in a position to fix it, rather than
# discovered on a published PDF three versions later.
stated = re.search(r'For app version ([0-9.]+)', md_text)
if not stated or stated.group(1) != VERSION:
    raise SystemExit(
        f"USER-MANUAL.md says version {stated.group(1) if stated else '(none)'}, "
        f"app/app.json says {VERSION}. Update the line under the title."
    )
body = markdown.markdown(md_text, extensions=['tables', 'smarty'])
# The cover page carries the title/version, so drop the markdown's own H1 and
# the version line to avoid saying it twice.
body = re.sub(r'<h1>.*?</h1>', '', body, count=1)
body = re.sub(r'<p><em>For app version.*?</em></p>', '', body, count=1)

logo_b64 = base64.b64encode((HERE.parent / 'app/assets/logo.png').read_bytes()).decode()

cover = f"""
<div class="cover">
  <img class="cover-logo" src="data:image/png;base64,{logo_b64}" alt="Sabeel Institute">
  <div class="cover-title">{COVER_TITLE}</div>
  <div class="cover-sub">User Manual</div>
  <div class="cover-meta">App version {VERSION} &nbsp;·&nbsp; {DATELINE}</div>
</div>
"""

html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  @page {{ size: A4; margin: 17mm 15mm; }}
  html {{ -webkit-print-color-adjust: exact; }}
  body {{ font-family: Georgia, 'Times New Roman', serif; color: #3A2F28;
         font-size: 13pt; line-height: 1.65; margin: 0; }}

  /* ---- Cover ---- */
  .cover {{ height: 240mm; display: flex; flex-direction: column;
            align-items: center; justify-content: center; text-align: center;
            page-break-after: always; }}
  .cover-logo {{ width: 110mm; border: none; }}
  .cover-title {{ font-size: 34pt; font-weight: bold; color: #83114F; margin-top: 14mm; }}
  .cover-sub {{ font-size: 20pt; color: #795E2A; margin-top: 4mm; }}
  .cover-meta {{ font-size: 12pt; color: #6A5748; margin-top: 18mm; }}

  /* ---- Headings: parts on fresh pages, never stranded above their content ---- */
  h1 {{ color: #83114F; font-size: 23pt; line-height: 1.25;
        border-bottom: 2.5px solid #C6A15B; padding-bottom: 8px;
        page-break-before: always; page-break-after: avoid; margin: 0 0 14px; }}
  h2 {{ color: #83114F; font-size: 16.5pt; margin: 26px 0 8px;
        page-break-after: avoid; }}
  h3 {{ color: #660D3E; font-size: 13.5pt; margin: 20px 0 6px;
        page-break-after: avoid; }}

  p, li {{ orphans: 3; widows: 3; }}
  ul, ol {{ padding-left: 22px; }}
  li {{ margin-bottom: 5px; }}

  /* ---- Screenshots ---- */
  /* A lone image (rare) keeps the old centred treatment. */
  img {{ display: block; width: 74mm; margin: 12px auto;
         border: 1px solid #DFD1C1; border-radius: 8px;
         page-break-inside: avoid; }}

  /* A phone/desktop pair: phone specimen first (this app is phone-first),
     the wide view below it, each with a quiet caption. Kept together. */
  .pair {{ page-break-inside: avoid; margin: 16px 0 20px; text-align: center; }}
  .pair figure {{ margin: 6px auto 10px; }}
  .pair figcaption {{ font-size: 9.5pt; color: #6A5748; font-style: italic;
                      letter-spacing: 0.03em; margin-top: 4px; }}
  .pair figure.ph img {{ width: 56mm; margin: 0 auto; }}
  .pair figure.wd img {{ width: 165mm; margin: 0 auto; }}

  table {{ border-collapse: collapse; width: 100%; font-size: 11pt;
           page-break-inside: avoid; }}
  th, td {{ border: 1px solid #DFD1C1; padding: 7px 9px; text-align: left;
            vertical-align: top; }}
  th {{ background: #F6EBDD; color: #660D3E; }}

  code {{ font-family: 'DejaVu Sans Mono', monospace; font-size: 11pt;
          background: #F6EBDD; padding: 1px 5px; border-radius: 3px; }}
  strong {{ color: #660D3E; }}
  em {{ color: #6A5748; }}
  hr {{ border: none; border-top: 1px solid #C6A15B; margin: 24px 0; }}
  a {{ color: #83114F; }}
</style></head><body>{cover}{body}</body></html>"""

out = HERE / 'USER-MANUAL.html'
out.write_text(html)
subprocess.run(
    ['google-chrome', '--headless', '--disable-gpu', '--no-sandbox',
     '--generate-pdf-document-outline', '--no-pdf-header-footer',
     f'--print-to-pdf={HERE / "USER-MANUAL.pdf"}', str(out)],
    check=True,
)
out.unlink()
print('USER-MANUAL.pdf rendered,', (HERE / 'USER-MANUAL.pdf').stat().st_size, 'bytes')
