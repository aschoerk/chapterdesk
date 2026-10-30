/**
 * download.ts
 *
 * Shared "download a URL as a file" helper used by the chat node attachment
 * chips, the log view image sections and the image lightbox.
 *
 * Two URL shapes reach this helper:
 *   – `data:` URLs (attachments are stored as data URLs; generated log
 *     pictures often are too). An `<a download>` click works directly.
 *   – `http(s)://` URLs (e.g. provider-hosted pictures in the log view).
 *     The `download` attribute is ignored cross-origin, so the bytes are
 *     fetched and re-served as a local object URL first. When the fetch
 *     fails (CORS / offline), we fall back to opening the URL in a new tab
 *     so the user can still save it manually.
 */

/** True when the URL is a data: URL. */
export function isDataUrl(url: string): boolean {
  return url.startsWith('data:');
}

/** True when the URL is an http(s) URL. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Derive a sensible download filename from a URL. `fallback` is used when the
 * URL carries no usable name (e.g. a data URL without a filename).
 */
export function filenameFromUrl(url: string, fallback = 'image.png'): string {
  if (isDataUrl(url)) {
    // data:image/png;base64,… → image.png
    const mime = /^data:([^;,]+)/i.exec(url)?.[1] ?? '';
    const ext = mime.split('/')[1]?.split('+')[0];
    if (ext && /^[a-z0-9]+$/i.test(ext)) return `image.${ext}`;
    return fallback;
  }
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').pop();
    if (name && name.includes('.')) return decodeURIComponent(name);
  } catch {
    // not a parseable URL — fall through
  }
  return fallback;
}

/**
 * Trigger a browser download of `url` under `filename`.
 *
 * For `data:` URLs this is a plain anchor click (`download` is honored for
 * data URLs). For `http(s)` URLs the resource is fetched and downloaded as a
 * blob (so the `download` attribute works cross-origin too); when the fetch
 * is blocked, the URL is opened in a new tab as a last resort.
 */
export function downloadUrl(url: string, filename: string): void {
  if (isDataUrl(url)) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (isHttpUrl(url)) {
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      })
      .catch(() => {
        // Cross-origin / CORS-blocked / offline: open the URL so the user can
        // still save it manually.
        window.open(url, '_blank', 'noopener');
      });
    return;
  }
  // Unknown scheme — best effort anchor click.
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}