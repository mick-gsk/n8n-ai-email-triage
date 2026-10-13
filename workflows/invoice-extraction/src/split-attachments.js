// @ts-check
// n8n Code node "Split attachments" (mode: run once for all items).
// Turns each email from the trigger into one item per PDF or image attachment, with the file as
// binary property "file". Files that cannot go to Claude are not dropped silently: a file over the
// size limit, or an email without any usable file, becomes an item with status "review" that skips
// Claude and goes straight to the review channel.
const MEDIA_TYPES = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};
// Keeps the base64 form of an image under the API's 5 MB image limit.
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const MAX_TEXT = 300;

/**
 * @typedef {object} Binary n8n binary data (metadata; in filesystem mode `data` is only a reference).
 * @property {string} [data]
 * @property {string} [id]
 * @property {string} [mimeType]
 * @property {string} [fileName]
 * @property {number} [bytes]
 *
 * @typedef {object} GmailMessage Gmail Trigger output with "Simplify" off (fields used here).
 * @property {string} id
 * @property {string} threadId
 * @property {string[]} [labelIds]
 * @property {{ value?: { address?: string }[], text?: string }} [from]
 * @property {string} [subject]
 * @property {string} [date]
 *
 * @typedef {{ maxPdfMB: number, minImageKB: number, processedLabelId: string, reviewLabelId: string }} Settings
 */

/** @param {Binary} file */
function mediaType(file) {
  const mime = String(file.mimeType ?? '').toLowerCase();
  if (mime in MEDIA_TYPES) return mime;
  // Some mail systems send PDFs as application/octet-stream; the extension is the next best hint.
  const ext = String(file.fileName ?? '')
    .toLowerCase()
    .split('.')
    .pop();
  return Object.keys(MEDIA_TYPES).find((t) => MEDIA_TYPES[/** @type {keyof MEDIA_TYPES} */ (t)].includes(ext ?? ''));
}

/** @param {Binary} file */
function size(file) {
  if (typeof file.bytes === 'number') return file.bytes;
  // Binary kept in memory (no id) has the base64 string itself in `data`.
  return !file.id && file.data ? Math.floor((file.data.length * 3) / 4) : 0;
}

/** @param {number} bytes */
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const settings = /** @type {Settings} */ ($('Settings').first().json);
const done = new Set([settings.processedLabelId, settings.reviewLabelId]);
/** @type {{ json: Record<string, unknown>, binary?: Record<string, Binary> }[]} */
const out = [];

for (const item of $('Gmail Trigger').all()) {
  const m = /** @type {GmailMessage} */ (item.json);
  // A manual "Execute workflow" run fetches recent mail again; mail this workflow has already
  // labelled is skipped so it does not produce a second row or review message.
  if ((m.labelIds ?? []).some((id) => done.has(id))) continue;

  const email = {
    message_id: m.id,
    thread_id: m.threadId,
    email_from: String(m.from?.value?.[0]?.address ?? m.from?.text ?? '').slice(0, MAX_TEXT),
    email_subject: String(m.subject ?? '').slice(0, MAX_TEXT),
    received_at: m.date ?? '',
    gmail_link: /^[0-9a-f]+$/i.test(m.id) ? `https://mail.google.com/mail/u/0/#all/${m.id}` : '',
    processed_at: new Date().toISOString(),
  };
  const files = Object.values(/** @type {Record<string, Binary>} */ (item.binary ?? {}));
  let used = 0;
  for (const file of files) {
    const type = mediaType(file);
    const bytes = size(file);
    const fileName = String(file.fileName ?? 'attachment').slice(0, 200);
    if (!type) continue;
    // Small images are logos and icons from email signatures, not scanned receipts.
    if (type !== 'application/pdf' && bytes < settings.minImageKB * 1024) continue;
    used++;
    const limit = type === 'application/pdf' ? settings.maxPdfMB * 1024 * 1024 : MAX_IMAGE_BYTES;
    if (bytes > limit) {
      out.push({
        json: {
          ...email,
          file_name: fileName,
          status: 'review',
          reasons: [`file too large for automatic reading (${mb(bytes)}, limit ${mb(limit)})`],
        },
      });
      continue;
    }
    out.push({
      json: { ...email, file_name: fileName, media_type: type, file_bytes: bytes, status: 'pending', reasons: [] },
      binary: { file },
    });
  }
  if (!used) {
    const names = files.map((f) => f.fileName ?? '?').join(', ');
    out.push({
      json: {
        ...email,
        file_name: names.slice(0, 200),
        status: 'review',
        reasons: [names ? `no PDF or image attachment (found: ${names})` : 'no attachment'],
      },
    });
  }
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return out;
