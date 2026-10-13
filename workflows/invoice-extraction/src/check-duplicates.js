// @ts-check
// n8n Code node "Check duplicates" (mode: run once for all items).
// Compares every valid invoice with the rows already in the Invoices sheet (the input of this
// node) and with the other invoices of this run. The same supplier and invoice number, or for
// receipts without a number the same supplier, date and total, is a duplicate. An IBAN that differs
// from the one on earlier invoices of the same supplier is sent to review, since a changed bank
// account is the usual pattern of invoice fraud.
// Also adds `reason`, the reasons as one line for Slack and the Review tab.

/**
 * @typedef {object} Row
 * @property {string} status
 * @property {string[]} reasons
 * @property {string} [document_type]
 * @property {string} [supplier_name]
 * @property {string} [supplier_vat_id]
 * @property {string} [invoice_number]
 * @property {string} [invoice_date]
 * @property {number | string | null} [gross_amount]
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
 * "INV-12-34" and "INV-123-4", or "Ä-1" and "Ö-1", stay different.
 * @param {unknown} s
 */
const number = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** @param {Row} a @param {Row} b */
function sameSupplier(a, b) {
  const [va, vb] = [code(a.supplier_vat_id), code(b.supplier_vat_id)];
  if (va && vb) return va === vb;
  return name(a.supplier_name) !== '' && name(a.supplier_name) === name(b.supplier_name);
}

/** @param {Row} a @param {Row} b */
function sameDocument(a, b) {
  if (!sameSupplier(a, b)) return false;
  const [na, nb] = [number(a.invoice_number), number(b.invoice_number)];
  if (na || nb) return na === nb;
  return a.invoice_date === b.invoice_date && Number(a.gross_amount) === Number(b.gross_amount);
}

/** @param {Earlier} e */
const where = ({ row, inSheet }) =>
  !inSheet
    ? 'another file in this run'
    : row.row_number
      ? `row ${row.row_number} of the Invoices sheet`
      : 'a row of the Invoices sheet';

// With an empty sheet the read node still outputs one empty item. Sheet rows and the invoices
// accepted earlier in this run are kept apart, so the reason can say which one matched.
/** @type {Earlier[]} */
const earlier = $input
  .all()
  .map((i) => /** @type {Row} */ (i.json))
  .filter((r) => r.invoice_number || r.supplier_name)
  .map((row) => ({ row, inSheet: true }));

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $('Collect results')
  .all()
  .map((item) => {
    const rec = /** @type {Row} */ ({ ...item.json, reasons: [.../** @type {Row} */ (item.json).reasons] });
    if (rec.status === 'ok') {
      const twin = earlier.find((e) => sameDocument(rec, e.row));
      const ibans = earlier.filter(({ row }) => row.iban && sameSupplier(rec, row)).map(({ row }) => code(row.iban));
      if (twin) {
        rec.status = 'duplicate';
        const same = number(rec.invoice_number) ? 'supplier and invoice number' : 'supplier, date and total';
        rec.reasons.push(`same ${same} as ${where(twin)}`);
      } else if (rec.iban && ibans.length && !ibans.includes(code(rec.iban))) {
        rec.status = 'review';
        rec.reasons.push(`IBAN differs from earlier invoices of this supplier (${[...new Set(ibans)].join(', ')})`);
      } else earlier.push({ row: rec, inSheet: false });
    }
    return { json: { ...rec, reason: rec.reasons.join('; ') }, binary: item.binary };
  });
