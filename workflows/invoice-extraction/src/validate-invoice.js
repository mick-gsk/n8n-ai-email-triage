// @ts-check
// n8n Code node "Validate" (mode: run once for all items).
// Turns Claude's reply into a normalised invoice record and checks it: dates to ISO, amounts to
// numbers, net + VAT = gross, VAT lines against their rates, IBAN checksum, VAT ID format, due
// date not before the invoice date. Every problem is collected as a reason and the item gets
// status "review"; only a record without any reason is written to the sheet as "ok".
// The reply is not trusted: the document it was read from may contain text aimed at the model.
// Allowed rounding difference, in cents; amounts are compared as whole cents, not as floats.
const TOLERANCE_CENTS = 2;
const MAX_TEXT = 200;
const MAX_LINE_ITEMS = 100;
const TYPES = ['invoice', 'credit_note', 'receipt', 'not_invoice'];
// Month names in English and German (including the Austrian "Jänner"), January first.
const MONTHS = [
  'jan january januar jänner',
  'feb february februar',
  'mar march mär märz mrz',
  'apr april',
  'may mai',
  'jun june juni',
  'jul july juli',
  'aug august',
  'sep sept september',
  'oct october okt oktober',
  'nov november',
  'dec december dez dezember',
].map((names) => names.split(' '));
// Symbols that name one currency. "$", "kr", "¥" and the like are used by several currencies and
// are not mapped; the document then goes to review unless the model gave an ISO code.
const CURRENCY_SYMBOLS = { '€': 'EUR', '£': 'GBP', US$: 'USD', SFR: 'CHF', 'FR.': 'CHF' };
// Current ISO 4217 currency codes (no funds codes, precious metals or test codes).
const CURRENCIES = new Set(
  (
    'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD ' +
    'CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF ' +
    'GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK ' +
    'LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD ' +
    'OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN ' +
    'SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG ' +
    'XOF XPF YER ZAR ZMW ZWG ' +
    // Replaced recently (Bulgaria joined the euro in 2026, XCG replaced ANG in 2025); older invoices use them.
    'BGN ANG'
  ).split(' '),
);
// IBAN length per country, from the SWIFT IBAN registry (release 101). Territories that use
// another country's IBANs (Åland: FI, Jersey: GB, French overseas departments: FR) are covered by it.
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
const VAT_ID_FORMATS = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CH: /^CHE\d{9}(MWST|TVA|IVA)?$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/,
  GB: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  NO: /^NO\d{9}(MVA)?$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(\d{9}|\d{12})$/,
};

/**
 * @typedef {object} ClaudeResponse Ask Claude output: a Messages API response, or { error } after failed retries.
 * @property {{ type: string, text?: string }[]} [content]
 * @property {string} [stop_reason]
 * @property {string | { message?: string }} [error]
 *
 * @typedef {Record<string, any>} Extraction Claude's reply, shaped by src/schema.json but not trusted.
 * @typedef {{ dateOrder: 'DMY' | 'MDY' }} Settings
 *
 * @typedef {object} Invoice
 * @property {string} status "ok", "review" or "not_invoice"
 * @property {string[]} reasons why the status is not "ok"
 * @property {string} document_type
 * @property {string} supplier_name
 * @property {string} supplier_vat_id normalised, e.g. DE123456789
 * @property {string} invoice_number
 * @property {string} invoice_date YYYY-MM-DD or ''
 * @property {string} due_date YYYY-MM-DD or ''
 * @property {string} currency ISO 4217 or ''
 * @property {number | null} net_amount
 * @property {number | null} vat_amount
 * @property {number | null} gross_amount
 * @property {{ rate: number | null, net: number | null, vat: number | null }[]} vat_lines
 * @property {string} iban normalised, without spaces
 * @property {{ description: string, quantity: string, unit_price: string, amount: number | null }[]} line_items
 */

/** @param {unknown} v */
const text = (v, max = MAX_TEXT) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/** @param {number} n */
const cents = (n) => Math.round(n * 100);

/** @param {number} a @param {number} b */
const differs = (a, b) => Math.abs(cents(a) - cents(b)) > TOLERANCE_CENTS;

/** @param {number | null} n */
const fmt = (n) => (n === null ? '?' : n.toFixed(2));

/**
 * "1.234,56", "1,234.56", "1.234,56-", "(1,234.56)", "€ 1 234,56" -> number. Throws on anything
 * that does not fit the document's number format, rather than guessing.
 * @param {unknown} raw
 * @param {string} decimal ',' or '.'
 * @returns {number | null}
 */
function parseAmount(raw, decimal) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Currency symbols and codes, spaces as thousands separators, Swiss apostrophes.
  s = s.replace(/[\u2212\u2013]/g, '-').replace(/[A-Za-z€$£¥\s\u00a0\u202f'\u2019]/g, '');
  // A trailing minus ("1.234,56-") is common in German accounting.
  if (/^-/.test(s) || /-$/.test(s)) {
    negative = !negative;
    s = s.replace(/^-|-$/g, '');
  } else s = s.replace(/^\+/, '');
  const thousands = decimal === ',' ? '.' : ',';
  const [whole, fraction, ...rest] = s.split(decimal);
  const groups = whole.split(thousands);
  const valid =
    !rest.length &&
    /^\d+$/.test(groups[0]) &&
    (groups.length === 1 || (groups[0].length <= 3 && groups.slice(1).every((g) => /^\d{3}$/.test(g)))) &&
    (fraction === undefined || /^\d+$/.test(fraction));
  if (!valid) throw new Error(`"${text(raw, 40)}" does not match the number format`);
  const n = Number(groups.join('') + (fraction === undefined ? '' : `.${fraction}`));
  if (!Number.isFinite(n)) throw new Error(`"${text(raw, 40)}" is not a usable amount`);
  return negative ? -n : n;
}

/** @param {string} name lower case, e.g. "okt" */
const month = (name) => MONTHS.findIndex((names) => names.includes(name)) + 1 || undefined;

/**
 * Printed date -> YYYY-MM-DD. Day/month order for dates with slashes or dashes comes from
 * Settings (DMY for Europe, MDY for the US), unless one part is above 12.
 * @param {unknown} raw
 * @param {'DMY' | 'MDY'} order
 * @returns {string} '' if empty
 */
function parseDate(raw, order) {
  const s = text(raw, 60).toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return '';
  let y, m, d;
  let match;
  if ((match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [, y, m, d] = match.map(Number);
  else if ((match = s.match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2}|\d{4})$/))) [, d, m, y] = match.map(Number);
  else if ((match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/))) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    y = Number(match[3]);
    const dayFirst = a > 12 ? true : b > 12 ? false : order !== 'MDY';
    [d, m] = dayFirst ? [a, b] : [b, a];
  } else if ((match = s.match(/^(\d{1,2})\.?\s([a-zäé]+)\.?\s(\d{4})$/))) {
    d = Number(match[1]);
    m = month(match[2]);
    y = Number(match[3]);
  } else if ((match = s.match(/^([a-zäé]+)\.?\s(\d{1,2})\s(\d{4})$/))) {
    m = month(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
  }
  if (y !== undefined && y < 100) y += 2000;
  const date = new Date(Date.UTC(y ?? NaN, (m ?? NaN) - 1, d ?? NaN));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== d || date.getUTCMonth() !== (m ?? 0) - 1)
    throw new Error(`"${text(raw, 40)}" is not a date`);
  return date.toISOString().slice(0, 10);
}

/** @param {string} iban normalised */
function ibanValid(iban) {
  const country = iban.slice(0, 2);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  // A country outside the registry has no IBAN.
  if (iban.length !== IBAN_LENGTHS[country]) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const c of digits) rest = (rest * 10 + Number(c)) % 97;
  return rest === 1;
}

/**
 * German VAT IDs carry a check digit (ISO 7064, MOD 11,10).
 * @param {string} id normalised, DE + 9 digits
 */
function germanVatIdValid(id) {
  const digits = id.slice(2).split('').map(Number);
  let product = 10;
  for (const digit of digits.slice(0, 8)) {
    const sum = (digit + product) % 10 || 10;
    product = (2 * sum) % 11;
  }
  return (11 - product) % 10 === digits[8];
}

/**
 * @param {string} id normalised
 * @returns {string} problem, or '' if the format is fine or the country is not one we know
 */
function vatIdProblem(id) {
  const country = /** @type {keyof VAT_ID_FORMATS} */ (id.slice(0, 2));
  if (!/^[A-Z]{2}/.test(id)) return `VAT ID "${id}" does not start with a country code`;
  const format = VAT_ID_FORMATS[country];
  if (format && !format.test(id)) return `VAT ID "${id}" does not match the ${country} format`;
  if (country === 'DE' && !germanVatIdValid(id)) return `VAT ID "${id}" has a wrong check digit`;
  return '';
}

/** @param {unknown} raw */
function currencyCode(raw) {
  const s = text(raw, 10).toUpperCase();
  return CURRENCY_SYMBOLS[/** @type {keyof CURRENCY_SYMBOLS} */ (s)] ?? s;
}

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
 * @param {Settings} settings
 * @param {Date} now
 * @returns {Invoice}
 */
function validate(raw, settings, now) {
  /** @type {string[]} */
  const reasons = [];
  const type = TYPES.includes(raw.document_type) ? raw.document_type : '';
  if (!type) reasons.push(`unknown document type "${text(raw.document_type, 40)}"`);
  const decimal = raw.number_format === '1,234.56' ? '.' : raw.number_format === '1.234,56' ? ',' : '';
  if (!decimal && type !== 'not_invoice') reasons.push('number format missing');

  /**
   * Parses one field; a failure becomes a reason and the field stays empty.
   * @param {string} label
   * @param {unknown} value
   * @param {'amount' | 'date'} kind
   */
  function field(label, value, kind) {
    try {
      return kind === 'date' ? parseDate(value, settings.dateOrder) : parseAmount(value, decimal || ',');
    } catch (err) {
      reasons.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return kind === 'date' ? '' : null;
    }
  }
  /** @param {string} label @param {unknown} v */
  const amount = (label, v) => /** @type {number | null} */ (field(label, v, 'amount'));
  /** @param {string} label @param {unknown} v */
  const date = (label, v) => /** @type {string} */ (field(label, v, 'date'));
  /** @param {unknown} v "19 %", "7,0"; null if empty or not a plain number */
  const rate = (v) => {
    const s = String(v ?? '')
      .replace(/[\s%]/g, '')
      .replace(',', '.');
    return /^\d{1,3}(\.\d{1,2})?$/.test(s) ? Number(s) : null;
  };
  const vatLines = Array.isArray(raw.vat_lines) ? raw.vat_lines.slice(0, 20) : [];
  const lineItems = Array.isArray(raw.line_items) ? raw.line_items.slice(0, MAX_LINE_ITEMS) : [];

  /** @type {Invoice} */
  const inv = {
    status: 'ok',
    reasons,
    document_type: type,
    supplier_name: text(raw.supplier_name),
    supplier_vat_id: text(raw.supplier_vat_id, 40)
      .toUpperCase()
      .replace(/[\s.\-/]/g, ''),
    invoice_number: text(raw.invoice_number, 60),
    invoice_date: date('invoice date', raw.invoice_date),
    due_date: date('due date', raw.due_date),
    currency: currencyCode(raw.currency),
    net_amount: amount('net amount', raw.net_amount),
    vat_amount: amount('VAT amount', raw.vat_amount),
    gross_amount: amount('gross amount', raw.gross_amount),
    vat_lines: vatLines.map((/** @type {any} */ l, /** @type {number} */ i) => ({
      rate: rate(l?.rate),
      net: amount(`VAT line ${i + 1} net`, l?.net),
      vat: amount(`VAT line ${i + 1} VAT`, l?.vat),
    })),
    iban: text(raw.iban, 50).toUpperCase().replace(/[\s-]/g, ''),
    line_items: lineItems.map((/** @type {any} */ l, /** @type {number} */ i) => ({
      description: text(l?.description, 300),
      quantity: text(l?.quantity, 20),
      unit_price: text(l?.unit_price, 20),
      amount: amount(`line item ${i + 1}`, l?.amount),
    })),
  };

  if (type === 'not_invoice') {
    return { ...inv, status: 'not_invoice', reasons: ['not an invoice, credit note or receipt'] };
  }

  const uncertain = (Array.isArray(raw.uncertain_fields) ? raw.uncertain_fields : []).map((f) => text(f, 30));
  if (uncertain.length) reasons.push(`unclear on the document: ${uncertain.join(', ')}`);

  if (!inv.supplier_name) reasons.push('supplier name missing');
  if (!inv.invoice_number && type !== 'receipt') reasons.push('invoice number missing');
  if (!text(raw.invoice_date)) reasons.push('invoice date missing');
  if (inv.invoice_date && inv.invoice_date > new Date(now.getTime() + 86400000).toISOString().slice(0, 10))
    reasons.push(`invoice date ${inv.invoice_date} is in the future`);

  const days = Number(text(raw.payment_terms_days, 5));
  if (!inv.due_date && inv.invoice_date && Number.isInteger(days) && days > 0 && days <= 365) {
    const due = new Date(`${inv.invoice_date}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + days);
    inv.due_date = due.toISOString().slice(0, 10);
  }
  if (inv.due_date && inv.invoice_date && inv.due_date < inv.invoice_date)
    reasons.push(`due date ${inv.due_date} is before invoice date ${inv.invoice_date}`);

  if (!CURRENCIES.has(inv.currency)) reasons.push(`currency "${inv.currency}" is not an ISO 4217 code`);

  // Credit notes are stored with negative amounts, whichever way the document prints them.
  if (type === 'credit_note' && inv.gross_amount !== null && inv.gross_amount > 0) {
    /** @param {number | null} n */
    const neg = (n) => (n === null ? null : -n);
    inv.net_amount = neg(inv.net_amount);
    inv.vat_amount = neg(inv.vat_amount);
    inv.gross_amount = neg(inv.gross_amount);
    inv.vat_lines = inv.vat_lines.map((l) => ({ ...l, net: neg(l.net), vat: neg(l.vat) }));
    inv.line_items = inv.line_items.map((l) => ({ ...l, amount: neg(l.amount) }));
  }
  const { net_amount: net, vat_amount: vat, gross_amount: gross } = inv;
  if (gross === null) reasons.push('gross amount missing');
  else if (type !== 'credit_note' && gross < 0) reasons.push('negative total on an invoice (a credit note?)');
  else if (gross === 0) reasons.push('total is 0');
  if (type !== 'receipt' && (net === null || vat === null)) reasons.push('net or VAT amount missing');
  if (gross !== null && [net, vat].some((n) => n !== null && n !== 0 && Math.sign(n) !== Math.sign(gross)))
    reasons.push('amounts have mixed signs');
  if (net !== null && vat !== null && gross !== null && differs(net + vat, gross))
    reasons.push(`net ${fmt(net)} + VAT ${fmt(vat)} = ${fmt(round2(net + vat))}, but gross is ${fmt(gross)}`);

  inv.vat_lines.forEach((l, i) => {
    if (l.rate === null) reasons.push(`VAT line ${i + 1}: rate missing or unreadable`);
    else if (l.rate > 30) reasons.push(`VAT line ${i + 1}: rate ${l.rate}% is not plausible`);
    else if (l.net !== null && l.vat !== null && differs((l.net * l.rate) / 100, l.vat))
      reasons.push(`VAT line ${i + 1}: ${l.rate}% of ${fmt(l.net)} is not ${fmt(l.vat)}`);
  });
  /** @param {'net' | 'vat'} key */
  const lineSum = (key) => round2(inv.vat_lines.reduce((sum, l) => sum + (l[key] ?? 0), 0));
  if (inv.vat_lines.length && vat !== null && differs(lineSum('vat'), vat))
    reasons.push(`VAT lines add up to ${fmt(lineSum('vat'))}, but VAT total is ${fmt(vat)}`);
  if (inv.vat_lines.length && net !== null && differs(lineSum('net'), net))
    reasons.push(`VAT lines add up to net ${fmt(lineSum('net'))}, but net total is ${fmt(net)}`);

  if (inv.iban && !ibanValid(inv.iban)) reasons.push(`IBAN ${inv.iban} is not valid`);
  if (inv.supplier_vat_id) {
    const problem = vatIdProblem(inv.supplier_vat_id);
    if (problem) reasons.push(problem);
  }

  return { ...inv, status: reasons.length ? 'review' : 'ok' };
}

const settings = /** @type {Settings} */ ($('Settings').first().json);
const built = $('Build request').all();
const now = new Date();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { file } = /** @type {{ file: Record<string, unknown> }} */ (built[i].json);
  /** @type {Partial<Invoice> & { status: string, reasons: string[] }} */
  let result;
  try {
    result = validate(readReply(/** @type {ClaudeResponse} */ (item.json)), settings, now);
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
