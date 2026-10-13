// @ts-check
// n8n Code node "Check duplicates" (mode: run once for all items).
// Compares every valid invoice with the rows already in the Invoices sheet (the input of this
// node) and with the other invoices of this run. The same seller and invoice number is a
// duplicate. An IBAN that differs from the one on earlier invoices of the same seller is sent to
// review, since a changed bank account is the usual pattern of invoice fraud; a correct XML file
// does not make the account in it correct.
// Also adds `reason`, the reasons as one line for Slack and the Review tab.

/**
 * @typedef {object} Row
 * @property {string} status
 * @property {string[]} reasons
 * @property {string} [message_id]
 * @property {string} [seller_name]
 * @property {string} [seller_vat_id]
 * @property {string} [invoice_number]
 * @property {string} [iban]
 * @property {number} [row_number] set by the Google Sheets node on rows it reads
 *
 * @typedef {{ row: Row, inSheet: boolean }} Earlier an invoice to compare with, and where it came from
 */

const LEGAL_FORMS =
  /\b(gmbh|mbh|ag|kg|ohg|ug|e\s?k|e\s?v|gbr|co|ltd|limited|llc|inc|plc|sarl|sas|sa|srl|spa|bv|nv|se)\b/g;

/** @param {unknown} s */
const name = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[.,&+]/g, ' ')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '');

/** @param {unknown} s VAT ID or IBAN: ASCII letters and digits only */
const code = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Invoice number for comparison: case and Unicode forms folded, and any run of spaces or
 * punctuation reduced to one separator, so "RE 2026/0042" equals "re-2026-0042" while
 * "INV-12-34" and "INV-123-4" stay different.
 * @param {unknown} s
 */
const number = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** @param {Row} a @param {Row} b */
function sameSeller(a, b) {
  const [va, vb] = [code(a.seller_vat_id), code(b.seller_vat_id)];
  if (va && vb) return va === vb;
  return name(a.seller_name) !== '' && name(a.seller_name) === name(b.seller_name);
}

/** @param {Earlier} e */
const where = ({ row, inSheet }) =>
  !inSheet
    ? 'another email in this run'
    : row.row_number
      ? `row ${row.row_number} of the Invoices sheet`
      : 'a row of the Invoices sheet';

// With an empty sheet the read node still outputs one empty item.
/** @type {Earlier[]} */
const earlier = $input
  .all()
  .map((i) => /** @type {Row} */ (i.json))
  .filter((r) => r.invoice_number)
  .map((row) => ({ row, inSheet: true }));

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $('Collect results')
  .all()
  .map((item) => {
    const rec = /** @type {Row} */ ({ ...item.json, reasons: [.../** @type {Row} */ (item.json).reasons] });
    if (rec.status === 'ok') {
      const twin = earlier.find(
        (e) => sameSeller(rec, e.row) && number(e.row.invoice_number) === number(rec.invoice_number),
      );
      const ibans = earlier.filter(({ row }) => row.iban && sameSeller(rec, row)).map(({ row }) => code(row.iban));
      if (twin) {
        rec.status = 'duplicate';
        rec.reasons.push(`same seller and invoice number as ${where(twin)}`);
      } else if (rec.iban && ibans.length && !ibans.includes(code(rec.iban))) {
        rec.status = 'review';
        rec.reasons.push(`IBAN differs from earlier invoices of this seller (${[...new Set(ibans)].join(', ')})`);
      } else earlier.push({ row: rec, inSheet: false });
    }
    return { json: { ...rec, reason: rec.reasons.join('; ') }, binary: item.binary };
  });
