// @ts-check
// n8n Code node "Validate" (mode: run once for all items).
// Turns Claude's reply into an invoice record. Anything that is not a well-formed reply (an API
// error, a refusal, a cut-off or malformed answer) becomes status "review" with the reason, so no
// file is silently dropped. The reply is not trusted: the document it was read from may contain
// text aimed at the model, so every field is checked or clamped here.
const MAX_TEXT = 200;
const MAX_LINE_ITEMS = 100;
const TYPES = ['invoice', 'credit_note', 'receipt', 'not_invoice'];

/**
 * @typedef {object} ClaudeResponse Ask Claude output: a Messages API response, or { error } after failed retries.
 * @property {{ type: string, text?: string }[]} [content]
 * @property {string} [stop_reason]
 * @property {string | { message?: string }} [error]
 *
 * @typedef {Record<string, any>} Extraction Claude's reply, shaped by src/schema.json but not trusted.
 *
 * @typedef {object} Invoice
 * @property {string} status "ok", "review" or "not_invoice"
 * @property {string[]} reasons why the status is not "ok"
 * @property {string} document_type
 * @property {string} supplier_name
 * @property {string} supplier_vat_id
 * @property {string} invoice_number
 * @property {string} invoice_date as printed
 * @property {string} due_date as printed
 * @property {string} currency
 * @property {string} net_amount as printed
 * @property {string} vat_amount as printed
 * @property {string} gross_amount as printed
 * @property {{ rate: string, net: string, vat: string }[]} vat_lines
 * @property {string} iban
 * @property {{ description: string, quantity: string, unit_price: string, amount: string }[]} line_items
 */

/** @param {unknown} v */
const text = (v, max = MAX_TEXT) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** @param {ClaudeResponse} res */
function readReply(res) {
  if (res.error)
    throw new Error(
      `API error: ${typeof res.error === 'string' ? res.error : (res.error.message ?? JSON.stringify(res.error))}`,
    );
  if (res.stop_reason === 'max_tokens') throw new Error('model reply cut off at max_tokens');
  if (res.stop_reason === 'refusal') throw new Error('model declined to read the document');
  const reply = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return /** @type {Extraction} */ (JSON.parse(reply.slice(start, end + 1)));
}

/**
 * @param {Extraction} raw
 * @returns {Invoice}
 */
function validate(raw) {
  /** @type {string[]} */
  const reasons = [];
  const type = TYPES.includes(raw.document_type) ? raw.document_type : '';
  if (!type) reasons.push(`unknown document type "${text(raw.document_type, 40)}"`);
  const vatLines = Array.isArray(raw.vat_lines) ? raw.vat_lines.slice(0, 20) : [];
  const lineItems = Array.isArray(raw.line_items) ? raw.line_items.slice(0, MAX_LINE_ITEMS) : [];

  /** @type {Invoice} */
  const inv = {
    status: 'ok',
    reasons,
    document_type: type,
    supplier_name: text(raw.supplier_name),
    supplier_vat_id: text(raw.supplier_vat_id, 40),
    invoice_number: text(raw.invoice_number, 60),
    invoice_date: text(raw.invoice_date, 40),
    due_date: text(raw.due_date, 40),
    currency: text(raw.currency, 10),
    net_amount: text(raw.net_amount, 40),
    vat_amount: text(raw.vat_amount, 40),
    gross_amount: text(raw.gross_amount, 40),
    vat_lines: vatLines.map((/** @type {any} */ l) => ({
      rate: text(l?.rate, 20),
      net: text(l?.net, 40),
      vat: text(l?.vat, 40),
    })),
    iban: text(raw.iban, 50),
    line_items: lineItems.map((/** @type {any} */ l) => ({
      description: text(l?.description, 300),
      quantity: text(l?.quantity, 20),
      unit_price: text(l?.unit_price, 20),
      amount: text(l?.amount, 40),
    })),
  };

  if (type === 'not_invoice') {
    return { ...inv, status: 'not_invoice', reasons: ['not an invoice, credit note or receipt'] };
  }

  const uncertain = (Array.isArray(raw.uncertain_fields) ? raw.uncertain_fields : []).map((f) => text(f, 30));
  if (uncertain.length) reasons.push(`unclear on the document: ${uncertain.join(', ')}`);

  return { ...inv, status: reasons.length ? 'review' : 'ok' };
}

const built = $('Build request').all();
const now = new Date();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { file } = /** @type {{ file: Record<string, unknown> }} */ (built[i].json);
  /** @type {Partial<Invoice> & { status: string, reasons: string[] }} */
  let result;
  try {
    result = validate(readReply(/** @type {ClaudeResponse} */ (item.json)));
  } catch (err) {
    // Ask Claude continues on error, so a failed call (after its retries) arrives here as
    // { error } and goes to review like any other problem.
    result = { status: 'review', reasons: [err instanceof Error ? err.message : String(err)] };
  }
  return {
    json: { ...file, ...result, processed_at: now.toISOString() },
    binary: built[i].binary,
    pairedItem: { item: i },
  };
});
