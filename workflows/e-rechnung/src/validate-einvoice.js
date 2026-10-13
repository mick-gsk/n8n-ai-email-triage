// @ts-check
// n8n Code node "Validate" (mode: run once for all items).
// Checks the data read from each e-invoice and turns it into a record for the sheet: required
// business terms present, amounts with at most two decimals, the EN 16931 sum rules compared in
// whole cents (lines, net, VAT, gross, amount due), the VAT breakdown, dates, IBAN checksum.
// Every problem is collected as a reason and the item gets status "review"; only a record without
// any reason is written to the sheet as "ok". The rules follow EN 16931 and XRechnung, but this is
// not a full validation: the KoSIT validator checks several hundred rules (see README).

// Invoice type codes allowed by XRechnung (BR-DE-17); 381 is a credit note.
const TYPE_CODES = ['326', '380', '381', '384', '389', '875', '876', '877'];
// VAT categories whose VAT amount is always 0: zero rated, exempt, reverse charge, intra-community,
// export, not subject to VAT.
const ZERO_VAT = ['Z', 'E', 'AE', 'K', 'G', 'O'];
// EN 16931 allows a VAT amount per category that differs from basis × rate by less than one
// currency unit (BR-S-09 and similar), to allow for VAT calculated per line.
const VAT_TOLERANCE_CENTS = 100;
const MAX_LINE_ITEMS = 100;
// IBAN length per country, from the SWIFT IBAN registry (release 101).
const IBAN_LENGTHS = Object.fromEntries(
  (
    'AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 ' +
    'EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 ' +
    'IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 ' +
    'NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 ' +
    'SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30'
  )
    .split(' ')
    .map((s) => [s.slice(0, 2), Number(s.slice(2))]),
);

/**
 * @typedef {Record<string, any>} Read output of Read e-invoice: file and email fields, status,
 *   reasons and, for a file that could be read, the invoice fields as text (see read-einvoice.js).
 *
 * @typedef {object} VatLine
 * @property {string} category BT-118
 * @property {number | null} rate BT-119, percent
 * @property {number | null} basis BT-116
 * @property {number | null} vat BT-117
 */

/** @param {number} c */
const fmt = (c) => (c / 100).toFixed(2);

/** @param {string} s */
const safeName = (s) =>
  s
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** @param {string} iban normalised */
function ibanValid(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length !== IBAN_LENGTHS[iban.slice(0, 2)]) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const c of digits) rest = (rest * 10 + Number(c)) % 97;
  return rest === 1;
}

/** @param {string} s */
const isoDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * @param {Read} r
 * @param {Date} now
 */
function validate(r, now) {
  /** @type {string[]} */
  const reasons = [];

  /**
   * An XML amount ("1234.5", "-12.00") as whole cents; null if empty. More than two decimals is
   * an error in EN 16931 for every amount checked here (BR-DEC rules).
   * @param {string} label
   * @param {unknown} raw
   * @param {boolean} [required]
   */
  const cents = (label, raw, required = false) => {
    const s = String(raw ?? '').trim();
    if (!s) {
      if (required) reasons.push(`${label} missing`);
      return null;
    }
    const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) {
      reasons.push(`${label} "${s.slice(0, 30)}" is not an amount with at most 2 decimals`);
      return null;
    }
    const c = Number(m[2] + (m[3] ?? '').padEnd(2, '0'));
    return m[1] === '-' ? -c : c;
  };
  /** @param {string} label @param {unknown} v */
  const need = (label, v) => {
    if (!String(v ?? '').trim()) reasons.push(`${label} missing`);
  };

  const cid = String(r.customization_id ?? '');
  const format =
    r.source === 'PDF'
      ? `ZUGFeRD PDF (${r.syntax})`
      : `${/xrechnung/i.test(cid) ? 'XRechnung' : 'EN 16931'} ${r.syntax}`;
  if (/minimum|basicwl/i.test(cid))
    reasons.push(`profile ${cid} is below EN 16931 (no line items), check the invoice by hand`);
  else need('specification (BT-24)', cid);

  need('invoice number (BT-1)', r.invoice_number);
  need('seller name (BT-27)', r.seller_name);
  need('seller country (BT-40)', r.seller_country);
  need('buyer name (BT-44)', r.buyer_name);

  const typeCode = String(r.type_code ?? '');
  if (!TYPE_CODES.includes(typeCode))
    reasons.push(`invoice type code "${typeCode}" is not one of ${TYPE_CODES.join(', ')}`);
  const credit = typeCode === '381';

  const currency = String(r.currency ?? '');
  if (!/^[A-Z]{3}$/.test(currency)) reasons.push(`currency "${currency}" is not an ISO 4217 code`);

  for (const [label, d] of [
    ['issue date (BT-2)', r.issue_date],
    ['due date (BT-9)', r.due_date],
  ])
    if (d && !isoDate(d)) reasons.push(`${label} "${String(d).slice(0, 20)}" is not a date`);
  if (!r.issue_date) reasons.push('issue date (BT-2) missing');
  if (isoDate(r.issue_date) && r.issue_date > new Date(now.getTime() + 86400000).toISOString().slice(0, 10))
    reasons.push(`issue date ${r.issue_date} is in the future`);
  if (isoDate(r.issue_date) && isoDate(r.due_date) && r.due_date < r.issue_date)
    reasons.push(`due date ${r.due_date} is before issue date ${r.issue_date}`);

  const lineTotal = cents('sum of line amounts (BT-106)', r.line_total, true);
  const allowances = cents('allowances (BT-107)', r.allowance_total) ?? 0;
  const charges = cents('charges (BT-108)', r.charge_total) ?? 0;
  const net = cents('net total (BT-109)', r.net_total, true);
  // BT-110 may be left out when there is no VAT.
  const vat = cents('VAT total (BT-110)', r.vat_total) ?? 0;
  const gross = cents('gross total (BT-112)', r.gross_total, true);
  const prepaid = cents('prepaid amount (BT-113)', r.prepaid) ?? 0;
  const rounding = cents('rounding amount (BT-114)', r.rounding) ?? 0;
  const payable = cents('amount due (BT-115)', r.payable, true);

  const lines = /** @type {Record<string, string>[]} */ (r.lines ?? []);
  if (!lines.length) reasons.push('no invoice lines (BG-25)');
  if (r.line_count > lines.length) reasons.push(`${r.line_count} invoice lines, more than this workflow reads`);
  const lineAmounts = lines.map((l, i) => cents(`line ${l.id || i + 1} amount (BT-131)`, l.net, true));
  if (lines.length && lineTotal !== null && lineAmounts.every((a) => a !== null) && r.line_count === lines.length) {
    const sum = lineAmounts.reduce((s, a) => s + (a ?? 0), 0);
    if (sum !== lineTotal)
      reasons.push(`lines add up to ${fmt(sum)}, but the line total (BT-106) is ${fmt(lineTotal)}`);
  }
  if (lineTotal !== null && net !== null && lineTotal - allowances + charges !== net)
    reasons.push(
      `line total ${fmt(lineTotal)} - allowances ${fmt(allowances)} + charges ${fmt(charges)} is not the net total ${fmt(net)}`,
    );
  if (net !== null && gross !== null && net + vat !== gross)
    reasons.push(`net ${fmt(net)} + VAT ${fmt(vat)} = ${fmt(net + vat)}, but gross is ${fmt(gross)}`);
  if (gross !== null && payable !== null && gross - prepaid + rounding !== payable)
    reasons.push(
      `gross ${fmt(gross)} - prepaid ${fmt(prepaid)} + rounding ${fmt(rounding)} is not the amount due ${fmt(payable)}`,
    );

  /** @type {VatLine[]} */
  const breakdown = (r.vat_breakdown ?? []).map((/** @type {Record<string, string>} */ b, /** @type {number} */ i) => {
    const label = `VAT breakdown ${i + 1}`;
    const rate = /^\d{1,3}(\.\d+)?$/.test(String(b.rate ?? '').trim()) ? Number(b.rate) : null;
    if (rate === null && b.category !== 'O') reasons.push(`${label}: rate (BT-119) missing or not a number`);
    return {
      category: String(b.category ?? ''),
      rate,
      basis: cents(`${label} taxable amount (BT-116)`, b.basis, true),
      vat: cents(`${label} VAT amount (BT-117)`, b.vat, true),
    };
  });
  if (!breakdown.length) reasons.push('no VAT breakdown (BG-23)');
  // A seller outside the scope of VAT (category O only) has neither.
  if (!r.seller_vat_id && !r.seller_tax_number && breakdown.some((b) => b.category !== 'O'))
    reasons.push('seller VAT ID (BT-31) and tax number (BT-32) missing');
  breakdown.forEach((b, i) => {
    if (b.basis === null || b.vat === null) return;
    if (ZERO_VAT.includes(b.category) && b.vat !== 0)
      reasons.push(`VAT breakdown ${i + 1}: category ${b.category} needs VAT 0, not ${fmt(b.vat)}`);
    else if (b.rate !== null && Math.abs(Math.round((b.basis * b.rate) / 100) - b.vat) >= VAT_TOLERANCE_CENTS)
      reasons.push(`VAT breakdown ${i + 1}: ${b.rate}% of ${fmt(b.basis)} is not ${fmt(b.vat)}`);
  });
  if (breakdown.length && breakdown.every((b) => b.basis !== null && b.vat !== null)) {
    const vatSum = breakdown.reduce((s, b) => s + (b.vat ?? 0), 0);
    const basisSum = breakdown.reduce((s, b) => s + (b.basis ?? 0), 0);
    if (vatSum !== vat) reasons.push(`VAT breakdown adds up to ${fmt(vatSum)}, but the VAT total is ${fmt(vat)}`);
    if (net !== null && basisSum !== net)
      reasons.push(`VAT breakdown taxable amounts add up to ${fmt(basisSum)}, but the net total is ${fmt(net)}`);
  }

  if (payable !== null && payable > 0 && !r.due_date && !r.payment_terms)
    reasons.push('neither due date (BT-9) nor payment terms (BT-20)');

  const iban = String(r.iban ?? '')
    .toUpperCase()
    .replace(/\s/g, '');
  if (r.payment_means_code === '58' && !iban) reasons.push('SEPA credit transfer (58) without IBAN (BT-84)');
  if (iban && (r.payment_means_code === '58' || /^[A-Z]{2}\d{2}/.test(iban)) && !ibanValid(iban))
    reasons.push(`IBAN ${iban} is not valid`);

  // Credit notes are stored with negative amounts, as in the invoice extraction workflow.
  const sign = credit ? -1 : 1;
  /** @param {number | null} c */
  const amount = (c) => (c === null ? null : (sign * c) / 100);
  const ext = r.media_type === 'application/pdf' ? 'pdf' : 'xml';
  return {
    status: reasons.length ? 'review' : 'ok',
    reasons,
    format,
    profile: cid,
    document_type: credit ? 'credit_note' : 'invoice',
    type_code: typeCode,
    invoice_number: r.invoice_number,
    issue_date: r.issue_date,
    due_date: r.due_date,
    currency,
    buyer_reference: r.buyer_reference,
    buyer_name: r.buyer_name,
    seller_name: r.seller_name,
    seller_vat_id: String(r.seller_vat_id ?? '')
      .toUpperCase()
      .replace(/[\s.\-/]/g, ''),
    seller_tax_number: r.seller_tax_number,
    seller_address: [r.seller_street, [r.seller_postcode, r.seller_city].filter(Boolean).join(' '), r.seller_country]
      .filter(Boolean)
      .join(', '),
    payment_terms: r.payment_terms,
    payment_means_code: r.payment_means_code,
    iban,
    net_amount: amount(net),
    vat_amount: amount(vat),
    gross_amount: amount(gross),
    payable_amount: amount(payable),
    vat_breakdown: breakdown.map((b) => ({ ...b, basis: amount(b.basis), vat: amount(b.vat) })),
    line_items: lines.slice(0, MAX_LINE_ITEMS).map((l, i) => ({
      id: l.id,
      name: l.name,
      quantity: l.quantity,
      unit: l.unit,
      amount: amount(lineAmounts[i]),
    })),
    line_count: r.line_count,
    drive_file_name: `${safeName(`${r.issue_date} ${r.seller_name} ${r.invoice_number}`).slice(0, 150)}.${ext}`,
  };
}

const now = new Date();
const FIELDS = [
  ...['message_id', 'thread_id', 'email_from', 'email_subject', 'received_at', 'gmail_link', 'processed_at'],
  ...['file_name', 'media_type', 'source'],
];

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const r = /** @type {Read} */ (item.json);
  const file = Object.fromEntries(FIELDS.map((f) => [f, r[f] ?? '']));
  // Files that could not be read keep their status and reasons.
  const result = r.status === 'pending' ? validate(r, now) : { status: r.status, reasons: r.reasons ?? [] };
  return { json: { ...file, ...result }, binary: item.binary, pairedItem: { item: i } };
});
