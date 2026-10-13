// @ts-check
// n8n Code node "Read e-invoice" (mode: run once for all items).
// Reads the invoice data from each file: an XRechnung (or other EN 16931) XML file in UBL or CII
// syntax, or a ZUGFeRD / Factur-X PDF, which carries its CII XML as an embedded file. Every value
// comes from an XML element; nothing is guessed, and there is no OCR. Values stay text here; the
// Validate node checks and converts them.
// The Code node has no XML parser, and zlib is only available if NODE_FUNCTION_ALLOW_BUILTIN
// allows it, so a small XML reader and an inflater for compressed PDF streams are part of this node.
// An email often carries the same invoice twice (XML plus a PDF copy, or a ZUGFeRD PDF plus its
// XML). Once one file of an email has been read, PDFs of that email without embedded XML and
// further copies of the same invoice are dropped.

// Inflated XML larger than this is not read (protects the run against compression bombs).
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 200;
const MAX_LINES = 500;

/**
 * @typedef {{ name: string, attrs: Record<string, string>, children: El[], text: string }} El
 *   An XML element: local name (namespace prefix removed), attributes by local name, child
 *   elements and its own text.
 *
 * @typedef {object} EInvoice Text values as found in the XML, by EN 16931 business term (BT).
 * @property {'UBL' | 'CII'} syntax
 * @property {string} customization_id BT-24, the specification (XRechnung, ZUGFeRD profile, ...)
 * @property {string} type_code BT-3: 380 invoice, 381 credit note, ...
 * @property {string} invoice_number BT-1
 * @property {string} issue_date BT-2, YYYY-MM-DD if the XML had a valid date format
 * @property {string} due_date BT-9
 * @property {string} currency BT-5
 * @property {string} buyer_reference BT-10, the Leitweg-ID for public buyers
 * @property {string} seller_name BT-27
 * @property {string} seller_vat_id BT-31
 * @property {string} seller_tax_number BT-32 (Steuernummer)
 * @property {string} seller_street BT-35, BT-36
 * @property {string} seller_postcode BT-38
 * @property {string} seller_city BT-37
 * @property {string} seller_country BT-40
 * @property {string} buyer_name BT-44
 * @property {string} payment_means_code BT-81 of the first payment means (58 = SEPA transfer)
 * @property {string} iban BT-84 of the first payment means that has an account
 * @property {string} payment_terms BT-20
 * @property {string} line_total BT-106
 * @property {string} allowance_total BT-107
 * @property {string} charge_total BT-108
 * @property {string} net_total BT-109
 * @property {string} vat_total BT-110
 * @property {string} gross_total BT-112
 * @property {string} prepaid BT-113
 * @property {string} rounding BT-114
 * @property {string} payable BT-115
 * @property {{ category: string, rate: string, basis: string, vat: string }[]} vat_breakdown BG-23
 * @property {{ id: string, name: string, quantity: string, unit: string, net: string }[]} lines BG-25
 * @property {number} line_count lines in the document (lines holds at most MAX_LINES)
 */

/** @type {Record<string, string>} */
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** @param {string} s */
const unescape = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    if (e in ENTITIES) return ENTITIES[e];
    throw new Error(`unknown entity &${e};`);
  });

/** @param {string} name */
const localName = (name) => name.slice(name.indexOf(':') + 1);

/**
 * A non-validating XML reader for well-formed documents. Namespaces are dropped (UBL and CII use
 * different prefixes from sender to sender); a DOCTYPE is refused, since e-invoices have none and
 * entity declarations are a known attack on XML readers.
 * @param {string} xml
 * @returns {El} the root element
 */
function parseXml(xml) {
  /** @type {El} */
  const doc = { name: '', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|(<!DOCTYPE)|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/y;
  let pos = 0;
  while (pos < xml.length) {
    token.lastIndex = pos;
    const m = token.exec(xml);
    if (!m) throw new Error(`XML is not well-formed near character ${pos}`);
    pos = token.lastIndex;
    const [, cdata, doctype, close, open, attrs, selfClose, chars] = m;
    const current = stack[stack.length - 1];
    if (doctype) throw new Error('XML with a DOCTYPE is not read');
    if (cdata !== undefined) current.text += cdata;
    else if (chars !== undefined) {
      if (current !== doc) current.text += unescape(chars);
      else if (chars.trim()) throw new Error('text outside the root element');
    } else if (close) {
      if (stack.length < 2 || current.name !== localName(close))
        throw new Error(`XML is not well-formed: unexpected </${close}>`);
      stack.pop();
    } else if (open) {
      /** @type {El} */
      const el = { name: localName(open), attrs: {}, children: [], text: '' };
      for (const a of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        el.attrs[localName(a[1])] = unescape(a[2] ?? a[3]);
      if (current === doc && doc.children.length) throw new Error('XML has more than one root element');
      current.children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  if (stack.length !== 1 || doc.children.length !== 1) throw new Error('XML is incomplete');
  return doc.children[0];
}

/**
 * All elements at a path of local names below el, in document order: "PaymentMeans/PaymentMeansCode".
 * @param {El | undefined} el
 * @param {string} path
 */
function findAll(el, path) {
  let level = el ? [el] : [];
  for (const step of path.split('/')) level = level.flatMap((e) => e.children.filter((c) => c.name === step));
  return level;
}

/** @param {El | undefined} el @param {string} path */
const find = (el, path) => findAll(el, path)[0];

/** Text of the first element at path (whitespace collapsed), or ''. @param {El | undefined} el @param {string} path */
const val = (el, path) => (find(el, path)?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** @param {string[]} parts */
const join = (parts) => parts.filter(Boolean).join(', ');

/**
 * CII date (udt:DateTimeString, format 102 = YYYYMMDD) as YYYY-MM-DD; other formats as found.
 * @param {El | undefined} el
 */
function ciiDate(el) {
  const s = (el?.text ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m && (el?.attrs.format ?? '102') === '102' ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

/** @param {El} root Invoice or CreditNote @returns {EInvoice} */
function fromUbl(root) {
  const credit = root.name === 'CreditNote';
  const seller = find(root, 'AccountingSupplierParty/Party');
  const address = find(seller, 'PostalAddress');
  const buyer = find(root, 'AccountingCustomerParty/Party');
  const currency = val(root, 'DocumentCurrencyCode');
  // A second TaxTotal, without breakdown, holds the VAT in the tax currency (BT-111).
  const taxTotals = findAll(root, 'TaxTotal');
  const taxTotal = taxTotals.find((t) => find(t, 'TaxAmount')?.attrs.currencyID === currency) ?? taxTotals[0];
  const sums = find(root, 'LegalMonetaryTotal');
  const means = findAll(root, 'PaymentMeans');
  const taxSchemes = findAll(seller, 'PartyTaxScheme');
  /** @param {boolean} vat */
  const taxId = (vat) =>
    taxSchemes
      .filter((p) => (val(p, 'TaxScheme/ID').toUpperCase() === 'VAT') === vat)
      .map((p) => val(p, 'CompanyID'))[0] ?? '';
  const lines = findAll(root, credit ? 'CreditNoteLine' : 'InvoiceLine');
  const quantity = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  return {
    syntax: 'UBL',
    customization_id: val(root, 'CustomizationID'),
    type_code: val(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'),
    invoice_number: val(root, 'ID'),
    issue_date: val(root, 'IssueDate'),
    due_date: val(root, 'DueDate') || means.map((m) => val(m, 'PaymentDueDate')).find(Boolean) || '',
    currency,
    buyer_reference: val(root, 'BuyerReference'),
    seller_name: val(seller, 'PartyLegalEntity/RegistrationName') || val(seller, 'PartyName/Name'),
    seller_vat_id: taxId(true),
    seller_tax_number: taxId(false),
    seller_street: join([val(address, 'StreetName'), val(address, 'AdditionalStreetName')]),
    seller_postcode: val(address, 'PostalZone'),
    seller_city: val(address, 'CityName'),
    seller_country: val(address, 'Country/IdentificationCode'),
    buyer_name: val(buyer, 'PartyLegalEntity/RegistrationName') || val(buyer, 'PartyName/Name'),
    payment_means_code: val(means[0], 'PaymentMeansCode'),
    iban: means.map((m) => val(m, 'PayeeFinancialAccount/ID')).find(Boolean) ?? '',
    payment_terms: findAll(root, 'PaymentTerms')
      .map((t) => val(t, 'Note'))
      .filter(Boolean)
      .join(' '),
    line_total: val(sums, 'LineExtensionAmount'),
    allowance_total: val(sums, 'AllowanceTotalAmount'),
    charge_total: val(sums, 'ChargeTotalAmount'),
    net_total: val(sums, 'TaxExclusiveAmount'),
    vat_total: val(taxTotal, 'TaxAmount'),
    gross_total: val(sums, 'TaxInclusiveAmount'),
    prepaid: val(sums, 'PrepaidAmount'),
    rounding: val(sums, 'PayableRoundingAmount'),
    payable: val(sums, 'PayableAmount'),
    vat_breakdown: findAll(taxTotal, 'TaxSubtotal').map((s) => ({
      category: val(s, 'TaxCategory/ID'),
      rate: val(s, 'TaxCategory/Percent'),
      basis: val(s, 'TaxableAmount'),
      vat: val(s, 'TaxAmount'),
    })),
    lines: lines.slice(0, MAX_LINES).map((l) => ({
      id: val(l, 'ID'),
      name: val(l, 'Item/Name'),
      quantity: val(l, quantity),
      unit: find(l, quantity)?.attrs.unitCode ?? '',
      net: val(l, 'LineExtensionAmount'),
    })),
    line_count: lines.length,
  };
}

/** @param {El} root CrossIndustryInvoice @returns {EInvoice} */
function fromCii(root) {
  const doc = find(root, 'ExchangedDocument');
  const tx = find(root, 'SupplyChainTradeTransaction');
  const agreement = find(tx, 'ApplicableHeaderTradeAgreement');
  const seller = find(agreement, 'SellerTradeParty');
  const address = find(seller, 'PostalTradeAddress');
  const settlement = find(tx, 'ApplicableHeaderTradeSettlement');
  const currency = val(settlement, 'InvoiceCurrencyCode');
  const sums = find(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  // TaxTotalAmount appears twice when a tax currency is used; the one in the invoice currency counts.
  const taxTotals = findAll(sums, 'TaxTotalAmount');
  const taxTotal = taxTotals.find((t) => t.attrs.currencyID === currency) ?? taxTotals[0];
  const means = findAll(settlement, 'SpecifiedTradeSettlementPaymentMeans');
  const terms = findAll(settlement, 'SpecifiedTradePaymentTerms');
  /** @param {string} scheme VA = VAT ID, FC = tax number */
  const taxId = (scheme) =>
    (findAll(seller, 'SpecifiedTaxRegistration/ID').find((r) => r.attrs.schemeID === scheme)?.text ?? '').trim();
  const lines = findAll(tx, 'IncludedSupplyChainTradeLineItem');
  return {
    syntax: 'CII',
    customization_id: val(root, 'ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID'),
    type_code: val(doc, 'TypeCode'),
    invoice_number: val(doc, 'ID'),
    issue_date: ciiDate(find(doc, 'IssueDateTime/DateTimeString')),
    due_date: terms.map((t) => ciiDate(find(t, 'DueDateDateTime/DateTimeString'))).find(Boolean) ?? '',
    currency,
    buyer_reference: val(agreement, 'BuyerReference'),
    seller_name: val(seller, 'Name'),
    seller_vat_id: taxId('VA'),
    seller_tax_number: taxId('FC'),
    seller_street: join([val(address, 'LineOne'), val(address, 'LineTwo'), val(address, 'LineThree')]),
    seller_postcode: val(address, 'PostcodeCode'),
    seller_city: val(address, 'CityName'),
    seller_country: val(address, 'CountryID'),
    buyer_name: val(agreement, 'BuyerTradeParty/Name'),
    payment_means_code: val(means[0], 'TypeCode'),
    iban:
      means
        .map(
          (m) =>
            val(m, 'PayeePartyCreditorFinancialAccount/IBANID') ||
            val(m, 'PayeePartyCreditorFinancialAccount/ProprietaryID'),
        )
        .find(Boolean) ?? '',
    payment_terms: terms
      .map((t) => val(t, 'Description'))
      .filter(Boolean)
      .join(' '),
    line_total: val(sums, 'LineTotalAmount'),
    allowance_total: val(sums, 'AllowanceTotalAmount'),
    charge_total: val(sums, 'ChargeTotalAmount'),
    net_total: val(sums, 'TaxBasisTotalAmount'),
    vat_total: (taxTotal?.text ?? '').trim(),
    gross_total: val(sums, 'GrandTotalAmount'),
    prepaid: val(sums, 'TotalPrepaidAmount'),
    rounding: val(sums, 'RoundingAmount'),
    payable: val(sums, 'DuePayableAmount'),
    vat_breakdown: findAll(settlement, 'ApplicableTradeTax').map((t) => ({
      category: val(t, 'CategoryCode'),
      rate: val(t, 'RateApplicablePercent'),
      basis: val(t, 'BasisAmount'),
      vat: val(t, 'CalculatedAmount'),
    })),
    lines: lines.slice(0, MAX_LINES).map((l) => ({
      id: val(l, 'AssociatedDocumentLineDocument/LineID'),
      name: val(l, 'SpecifiedTradeProduct/Name'),
      quantity: val(l, 'SpecifiedLineTradeDelivery/BilledQuantity'),
      unit: find(l, 'SpecifiedLineTradeDelivery/BilledQuantity')?.attrs.unitCode ?? '',
      net: val(l, 'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount'),
    })),
    line_count: lines.length,
  };
}

/**
 * Bytes to text, in the encoding the XML declares (UTF-8 if none). Invalid bytes are an error.
 * @param {Uint8Array} bytes
 */
function decodeText(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  const head = String.fromCharCode(...bytes.subarray(0, 200));
  const encoding =
    /^(?:\uFEFF|\u00EF\u00BB\u00BF)?<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/.exec(head)?.[1] ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(encoding.toLowerCase(), { fatal: true });
  } catch {
    throw new Error(`XML encoding "${encoding}" is not supported`);
  }
  try {
    return decoder.decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new Error(`XML is not valid ${encoding}`);
  }
}

// --- Inflate (RFC 1950 zlib / RFC 1951 deflate), for FlateDecode streams in PDFs ---------------

// Base values and extra bits of the deflate length (257..285) and distance (0..29) codes.
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Order in which the code length code lengths are stored.
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Canonical Huffman code from code lengths: count per length and symbols ordered by code.
 * @param {ArrayLike<number>} lengths
 */
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + counts[len - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  return { counts, symbols };
}

/**
 * @param {Uint8Array} data zlib stream (2-byte header, deflate data; the Adler-32 trailer is not checked)
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
function inflate(data, maxBytes) {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0)
    throw new Error('stream is not zlib data');
  let pos = 2;
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(maxBytes, Math.max(4096, data.length * 4)));
  let size = 0;

  /** @param {number} n */
  const bits = (n) => {
    while (bitCount < n) {
      if (pos >= data.length) throw new Error('compressed stream ends early');
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  /** @param {number} n */
  const room = (n) => {
    if (size + n <= out.length) return;
    if (size + n > maxBytes) throw new Error(`embedded file is larger than ${maxBytes / 1024 / 1024} MB`);
    const bigger = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, size + n)));
    bigger.set(out.subarray(0, size));
    out = bigger;
  };
  /** @param {{ counts: Uint16Array, symbols: Uint16Array }} h */
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('invalid compressed data');
  };

  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > data.length) throw new Error('compressed stream ends early');
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      if (pos + len > data.length) throw new Error('compressed stream ends early');
      room(len);
      out.set(data.subarray(pos, pos + len), size);
      size += len;
      pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      const lengths = new Uint8Array(288);
      lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
      lit = huffman(lengths);
      dist = huffman(new Uint8Array(30).fill(5));
    } else if (type === 2) {
      const nLit = bits(5) + 257;
      const nDist = bits(5) + 1;
      const nCode = bits(4) + 4;
      const clLengths = new Uint8Array(19);
      for (let i = 0; i < nCode; i++) clLengths[CL_ORDER[i]] = bits(3);
      const cl = huffman(clLengths);
      const lengths = new Uint8Array(nLit + nDist);
      for (let i = 0; i < nLit + nDist;) {
        const sym = decode(cl);
        if (sym < 16) lengths[i++] = sym;
        else {
          const [repeat, value] =
            sym === 16 ? [3 + bits(2), i ? lengths[i - 1] : -1] : sym === 17 ? [3 + bits(3), 0] : [11 + bits(7), 0];
          if (value < 0 || i + repeat > lengths.length) throw new Error('invalid compressed data');
          lengths.fill(value, i, i + repeat);
          i += repeat;
        }
      }
      lit = huffman(lengths.subarray(0, nLit));
      dist = huffman(lengths.subarray(nLit));
    } else throw new Error('invalid compressed data');

    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        room(1);
        out[size++] = sym;
      } else if (sym === 256) break;
      else {
        const l = sym - 257;
        if (l >= 29) throw new Error('invalid compressed data');
        const len = LENGTH_BASE[l] + bits(LENGTH_EXTRA[l]);
        const d = decode(dist);
        if (d >= 30) throw new Error('invalid compressed data');
        const back = DIST_BASE[d] + bits(DIST_EXTRA[d]);
        if (back > size) throw new Error('invalid compressed data');
        room(len);
        for (let k = 0; k < len; k++, size++) out[size] = out[size - back];
      }
    }
  }
  return out.subarray(0, size);
}

// --- PDF: embedded files ---------------------------------------------------------------------

/**
 * Contents of the embedded files of a PDF (ZUGFeRD / Factur-X put the invoice XML there). Embedded
 * file streams are always top-level objects, so they can be found without reading the
 * cross-reference table, also in PDFs that keep their other objects in compressed object streams.
 * @param {Uint8Array} bytes
 * @returns {(Uint8Array | string)[]} the content of each file, or why it cannot be read
 */
function embeddedFiles(bytes) {
  // latin1 maps every byte to one character, so string positions are byte positions.
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  if (/\/Encrypt\b/.test(s)) throw new Error('PDF is encrypted');
  /** @type {(Uint8Array | string)[]} */
  const files = [];
  for (const m of s.matchAll(/\d+\s+\d+\s+obj\s*<</g)) {
    // The object's dictionary, with nested dictionaries.
    const start = (m.index ?? 0) + m[0].length - 2;
    let depth = 0;
    let end = start;
    for (; end < s.length && end < start + 10000; end++) {
      if (s.startsWith('<<', end)) {
        depth++;
        end++;
      } else if (s.startsWith('>>', end)) {
        depth--;
        end++;
        if (!depth) break;
      }
    }
    const dict = s.slice(start, end + 1);
    // /Type is optional on embedded file streams; an XML subtype marks them too (but not XMP metadata).
    const embedded =
      /\/Type\s*\/EmbeddedFile\b/.test(dict) ||
      (/\/Subtype\s*\/\S*xml/i.test(dict) && !/\/Type\s*\/Metadata/.test(dict));
    const stream = /^\s*stream(\r\n|\n|\r)/.exec(s.slice(end + 1, end + 20));
    if (!embedded || !stream) continue;
    const dataStart = end + 1 + stream[0].length;
    // A direct /Length is used when it ends at "endstream"; otherwise (indirect length) the data
    // runs to the next "endstream".
    const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = direct ? dataStart + Number(direct[1]) : -1;
    if (dataEnd < 0 || !/^\s*endstream/.test(s.slice(dataEnd, dataEnd + 20))) {
      dataEnd = s.indexOf('endstream', dataStart);
      if (dataEnd < 0) continue;
      if (s[dataEnd - 1] === '\n') dataEnd--;
      if (s[dataEnd - 1] === '\r') dataEnd--;
    }
    const raw = bytes.subarray(dataStart, dataEnd);
    const filters = [...(/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '').matchAll(/\/(\w+)/g)].map((f) => f[1]);
    if (filters.length > 1 || filters.some((f) => f !== 'FlateDecode'))
      files.push(`unsupported PDF filter ${filters.join(', ')}`);
    else if (/\/Predictor\s+([2-9]|\d\d)/.test(dict)) files.push('unsupported PDF predictor');
    else if (!filters.length) files.push(raw);
    else {
      try {
        files.push(inflate(raw, MAX_XML_BYTES));
      } catch (err) {
        files.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return files;
}

/**
 * @typedef {{ status: string, reasons: string[], plain_pdf?: boolean, source?: string, invoice?: EInvoice }} ReadResult
 */

/**
 * Root element to invoice data, or the reason it is not an e-invoice this workflow reads.
 * @param {El} root
 * @returns {EInvoice}
 */
function invoiceFrom(root) {
  if (root.name === 'Invoice' || root.name === 'CreditNote') return fromUbl(root);
  if (root.name === 'CrossIndustryInvoice') return fromCii(root);
  if (root.name === 'CrossIndustryDocument')
    throw new Error('ZUGFeRD 1.0 XML: not an EN 16931 e-invoice, check the invoice by hand');
  throw new Error(`XML is not an e-invoice (root element ${root.name})`);
}

/**
 * @param {Uint8Array} bytes
 * @param {string} mediaType
 * @returns {ReadResult}
 */
function read(bytes, mediaType) {
  try {
    if (mediaType !== 'application/pdf')
      return { status: 'pending', reasons: [], source: 'XML', invoice: invoiceFrom(parseXml(decodeText(bytes))) };
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('file is not a PDF');
    const problems = [];
    for (const file of embeddedFiles(bytes)) {
      if (typeof file === 'string') {
        problems.push(file);
        continue;
      }
      try {
        return { status: 'pending', reasons: [], source: 'PDF', invoice: invoiceFrom(parseXml(decodeText(file))) };
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (problems.length) throw new Error(`embedded XML: ${problems.join('; ')}`);
    return {
      status: 'review',
      reasons: ['PDF without embedded e-invoice XML (not a ZUGFeRD or Factur-X file)'],
      plain_pdf: true,
    };
  } catch (err) {
    return { status: 'review', reasons: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * Same invoice, by seller, number and amount due (for copies of one invoice in one email).
 * @param {EInvoice} inv
 */
const fingerprint = (inv) => [inv.seller_vat_id || inv.seller_name, inv.invoice_number, inv.payable].join('|');

/** @type {{ json: Record<string, unknown>, binary?: Record<string, unknown>, pairedItem: { item: number } }[]} */
const results = [];
/** @type {Map<string, Set<string>>} fingerprints of the invoices read per email */
const seen = new Map();

$input.all().forEach((item, i) => {
  const { fileBase64, ...file } = /** @type {Record<string, any>} */ (item.json);
  const bytes = Buffer.from(String(fileBase64 ?? ''), 'base64');
  const { invoice, ...status } = read(bytes, file.media_type);
  if (invoice) {
    const prints = seen.get(file.message_id) ?? new Set();
    seen.set(file.message_id, prints);
    if (prints.has(fingerprint(invoice))) return;
    prints.add(fingerprint(invoice));
  }
  results.push({
    json: {
      ...file,
      ...status,
      ...(invoice ?? {}),
    },
    binary: item.binary,
    pairedItem: { item: i },
  });
});

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return results.filter((r) => !(r.json.plain_pdf && seen.get(String(r.json.message_id))?.size));
