// @ts-check
// n8n Code node "Split attachments" (mode: run once for all items).
// Turns each email from the trigger into one item per XML or PDF attachment, with the file as
// binary property "file". Other files (images, Word, ZIP) are ignored. A file over the size limit,
// or an email without any XML or PDF, becomes an item with status "review" that skips reading and
// goes straight to the review channel.
const XML_TYPES = ['application/xml', 'text/xml'];
// Types that say nothing about the content; only for these the file extension decides.
const GENERIC_TYPES = ['', 'application/octet-stream', 'binary/octet-stream'];
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
 * @typedef {{ maxFileMB: number, processedLabelId: string, reviewLabelId: string }} Settings
 */

/**
 * 'application/xml', 'application/pdf' or undefined for files that are not read.
 * @param {Binary} file
 */
function mediaType(file) {
  const mime = String(file.mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime === 'application/pdf') return mime;
  // XRechnung files also arrive as application/x-xrechnung+xml and similar.
  if (XML_TYPES.includes(mime) || /\+xml$/.test(mime)) return 'application/xml';
  if (!GENERIC_TYPES.includes(mime)) return undefined;
  const ext = String(file.fileName ?? '')
    .toLowerCase()
    .split('.')
    .pop();
  return ext === 'pdf' ? 'application/pdf' : ext === 'xml' ? 'application/xml' : undefined;
}

/** @param {Binary} file */
function size(file) {
  if (typeof file.bytes === 'number') return file.bytes;
  // Binary kept in memory (no id) has the base64 string itself in `data`.
  return !file.id && file.data ? Math.floor((file.data.length * 3) / 4) : 0;
}

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
    if (!type) continue;
    used++;
    const fileName = String(file.fileName ?? 'attachment').slice(0, 200);
    const bytes = size(file);
    if (bytes > settings.maxFileMB * 1024 * 1024) {
      out.push({
        json: {
          ...email,
          file_name: fileName,
          status: 'review',
          reasons: [`file too large (${(bytes / 1024 / 1024).toFixed(1)} MB, limit ${settings.maxFileMB} MB)`],
        },
      });
      continue;
    }
    out.push({
      json: { ...email, file_name: fileName, media_type: type, status: 'pending', reasons: [] },
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
        reasons: [names ? `no XML or PDF attachment (found: ${names})` : 'no attachment'],
      },
    });
  }
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return out;
