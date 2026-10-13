// @ts-check
// n8n Code node "Select files" (mode: run once for all items).
// Takes Google Drive file records (from the trigger or the folder listing) and keeps the ones the
// loader can read, with the fields stored on every chunk. File names come from whoever can edit
// the folder and are shown to customers as sources, so they are cleaned and shortened here.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NAME_CHARS = 200;
const SUPPORTED = new Set([
  'application/vnd.google-apps.document', // exported as Markdown by "Download file"
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

/**
 * @typedef {object} DriveFile Google Drive file resource (fields used here).
 * @property {string} id
 * @property {string} [name]
 * @property {string} [mimeType]
 * @property {string} [webViewLink]
 * @property {string | number} [size] bytes; absent for Google Docs
 * @property {boolean} [trashed]
 *
 * @typedef {{ file_id: string, file_name: string, mime_type: string, source_url: string }} SelectedFile
 */

/** @param {unknown} s */
const cleanName = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);

/** @param {DriveFile} f */
const readable = (f) => Boolean(f.id) && !f.trashed && SUPPORTED.has(f.mimeType ?? '') && !(Number(f.size) > MAX_BYTES);

const seen = new Set();
/** @type {SelectedFile[]} */
const files = [];
for (const item of $input.all()) {
  const f = /** @type {DriveFile} */ (item.json);
  if (!readable(f) || seen.has(f.id)) continue;
  seen.add(f.id);
  files.push({
    file_id: f.id,
    file_name: cleanName(f.name) || f.id,
    mime_type: f.mimeType ?? '',
    source_url: /^https:\/\/(docs|drive)\.google\.com\//.test(f.webViewLink ?? '') ? String(f.webViewLink) : '',
  });
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return files.map((json) => ({ json }));
