/**
 * Open a file the way this browser can: in a tab of its own when it shows that
 * kind of file, and otherwise saved from this page, under its own name.
 *
 * SHOWN, the tab opens ON THE TAP, before the link is minted: one opened when
 * the link arrives is no longer the person's own act, and Safari blocks it as a
 * popup. Blocked all the same, the file opens in this tab, and Back returns.
 *
 * SAVED, nothing opens. A tab sent to a file the browser only downloads is left
 * blank once the download starts — Chrome on Android, with a Word file or with
 * a PDF where it has no viewer — and sending THIS tab to it would ask "Leave
 * site?" on a screen with work in progress. So it is fetched and saved through
 * a link of the page's own.
 */
export async function openFile(file: { name: string; contentType: string }, link: () => Promise<string>): Promise<void> {
  if (!shows(file.contentType)) return save(file.name, link);
  const tab = window.open('', '_blank');
  try {
    const url = await link();
    if (!tab) {
      window.location.assign(url);
      return;
    }
    // The file's page cannot reach back into the app.
    tab.opener = null;
    tab.location.replace(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** What every browser shows in a tab: pictures, audio and text, and a PDF where it has a viewer. */
function shows(contentType: string): boolean {
  if (/^(image|audio|text)\//.test(contentType)) return true;
  return contentType === 'application/pdf' && navigator.pdfViewerEnabled;
}

async function save(name: string, link: () => Promise<string>): Promise<void> {
  const res = await fetch(await link()).catch(() => null);
  if (!res?.ok) throw new Error('The file did not download. Check the connection and try again.');
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to have taken it.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
