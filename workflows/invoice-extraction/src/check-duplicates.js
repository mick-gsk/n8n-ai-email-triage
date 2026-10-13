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
 * @property {number} [row_number] set on rows read from the sheet
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

/** @param {unknown} s */
const code = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** @param {Row} a @param {Row} b */
function sameSupplier(a, b) {
  const [va, vb] = [code(a.supplier_vat_id), code(b.supplier_vat_id)];
  if (va && vb) return va === vb;
  return name(a.supplier_name) !== '' && name(a.supplier_name) === name(b.supplier_name);
}

/** @param {Row} a @param {Row} b */
function sameDocument(a, b) {
  if (!sameSupplier(a, b)) return false;
  const [na, nb] = [code(a.invoice_number), code(b.invoice_number)];
  if (na || nb) return na === nb;
  return a.invoice_date === b.invoice_date && Number(a.gross_amount) === Number(b.gross_amount);
}

/** @param {Row} r */
const where = (r) => (r.row_number ? `row ${r.row_number} of the Invoices sheet` : 'another file in this run');

// With an empty sheet the read node still outputs one empty item.
const rows = $input
  .all()
  .map((i) => /** @type {Row} */ (i.json))
  .filter((r) => r.invoice_number || r.supplier_name);
/** @type {Row[]} */
const accepted = [];

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $('Collect results')
  .all()
  .map((item) => {
    const rec = /** @type {Row} */ ({ ...item.json, reasons: [.../** @type {Row} */ (item.json).reasons] });
    if (rec.status === 'ok') {
      const earlier = [...rows, ...accepted];
      const twin = earlier.find((r) => sameDocument(rec, r));
      const ibans = earlier.filter((r) => r.iban && sameSupplier(rec, r)).map((r) => code(r.iban));
      if (twin) {
        rec.status = 'duplicate';
        const same = code(rec.invoice_number) ? 'supplier and invoice number' : 'supplier, date and total';
        rec.reasons.push(`same ${same} as ${where(twin)}`);
      } else if (rec.iban && ibans.length && !ibans.includes(code(rec.iban))) {
        rec.status = 'review';
        rec.reasons.push(`IBAN differs from earlier invoices of this supplier (${[...new Set(ibans)].join(', ')})`);
      } else accepted.push(rec);
    }
    return { json: { ...rec, reason: rec.reasons.join('; ') }, binary: item.binary };
  });
