import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cii, fileItem, fixture, fixtures, plainPdf, readFiles, ubl, zugferdPdf } from './helpers.mjs';

const read = (content, fields) => readFiles([fileItem(content, fields)])[0];

const UBL_HEAD =
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ' +
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">';

test('reads the business terms of a UBL XRechnung', () => {
  const r = read(ubl);
  assert.equal(r.status, 'pending');
  assert.equal(r.source, 'XML');
  assert.equal(r.syntax, 'UBL');
  assert.equal(r.customization_id, 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0');
  assert.equal(r.type_code, '380');
  assert.equal(r.invoice_number, '123456XX');
  assert.equal(r.issue_date, '2016-04-04');
  assert.equal(r.currency, 'EUR');
  assert.equal(r.buyer_reference, '04011000-12345-03');
  assert.equal(r.seller_name, '[Seller name]');
  assert.equal(r.seller_vat_id, 'DE 123456789');
  assert.equal(r.seller_postcode, '12345');
  assert.equal(r.seller_country, 'DE');
  assert.equal(r.buyer_name, '[Buyer name]');
  assert.equal(r.payment_means_code, '58');
  assert.equal(r.iban, 'DE79000000001234567890');
  assert.equal(r.payment_terms, 'Zahlbar sofort ohne Abzug.');
  assert.deepEqual(
    [r.line_total, r.net_total, r.vat_total, r.gross_total, r.payable],
    ['314.86', '314.86', '22.04', '336.9', '336.9'],
  );
  assert.deepEqual(r.vat_breakdown, [{ category: 'S', rate: '7', basis: '314.86', vat: '22.04' }]);
  assert.equal(r.line_count, 2);
  assert.deepEqual(r.lines[1], {
    id: 'Porto + Versandkosten',
    name: 'Porto + Versandkosten',
    quantity: '1',
    unit: 'XPP',
    net: '26.07',
  });
  assert.equal(r.fileBase64, undefined, 'the file content is not passed on');
});

test('reads the business terms of a CII XRechnung, with CII dates as ISO dates', () => {
  const r = read(cii);
  assert.equal(r.syntax, 'CII');
  assert.equal(r.issue_date, '2016-04-04');
  assert.equal(r.invoice_number, '123456XX');
  assert.equal(r.iban, 'DE79000000001234567890');
  assert.equal(r.gross_total, '336.9');
  assert.deepEqual(r.vat_breakdown, [{ category: 'S', rate: '7', basis: '314.86', vat: '22.04' }]);
});

test('UBL and CII versions of every test suite invoice give the same data', () => {
  const pairs = fixtures.filter((f) => f.endsWith('_ubl.xml'));
  assert.ok(pairs.length >= 7);
  for (const f of pairs) {
    const [a, b] = readFiles([fileItem(fixture(f)), fileItem(fixture(f.replace('_ubl', '_uncefact')))]);
    for (const key of ['invoice_number', 'issue_date', 'due_date', 'currency', 'iban', 'line_count'])
      assert.equal(a[key], b[key], `${f}: ${key}`);
    for (const key of ['net_total', 'vat_total', 'gross_total', 'payable'])
      assert.equal(Number(a[key]), Number(b[key]), `${f}: ${key}`);
    assert.deepEqual(
      a.vat_breakdown.map((v) => [v.category, Number(v.rate), Number(v.vat)]),
      b.vat_breakdown.map((v) => [v.category, Number(v.rate), Number(v.vat)]),
      `${f}: VAT breakdown`,
    );
  }
});

test('reads a UBL credit note', () => {
  const xml = ubl
    .replace(/ubl:Invoice\b/g, 'ubl:CreditNote')
    .replace('schema:xsd:Invoice-2', 'schema:xsd:CreditNote-2')
    .replace(/InvoiceTypeCode>380</g, 'CreditNoteTypeCode>381<')
    .replace(/InvoiceTypeCode/g, 'CreditNoteTypeCode')
    .replace(/cac:InvoiceLine>/g, 'cac:CreditNoteLine>')
    .replace(/cbc:InvoicedQuantity/g, 'cbc:CreditedQuantity');
  const r = read(xml);
  assert.equal(r.type_code, '381');
  assert.equal(r.line_count, 2);
  assert.equal(r.lines[0].quantity, '1');
});

test('the XML reader handles entities, CDATA, comments, prefixes and single quotes', () => {
  const r = read(
    `<?xml version='1.0' encoding='UTF-8'?>\n<!-- comment -->\n${UBL_HEAD}` +
      `<cbc:ID>RE&#x2D;7 &amp; 8</cbc:ID><cbc:IssueDate><![CDATA[2026-10-02]]></cbc:IssueDate>` +
      `<cac:AccountingSupplierParty xmlns:cac='x'><cac:Party><cac:PartyName><cbc:Name>B&#228;ckerei &lt;Korn&gt;</cbc:Name>` +
      `</cac:PartyName></cac:Party></cac:AccountingSupplierParty><cbc:Note/></Invoice>`,
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.invoice_number, 'RE-7 & 8');
  assert.equal(r.issue_date, '2026-10-02');
  assert.equal(r.seller_name, 'Bäckerei <Korn>');
});

test('decodes the encoding the XML declares and refuses invalid bytes', () => {
  const latin1 = Buffer.from(
    `<?xml version="1.0" encoding="ISO-8859-1"?>${UBL_HEAD}<cbc:ID>Bäckerei</cbc:ID></Invoice>`,
    'latin1',
  );
  assert.equal(read(latin1).invoice_number, 'Bäckerei');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ubl)]);
  assert.equal(read(bom).invoice_number, '123456XX');
  const bad = Buffer.concat([
    Buffer.from(`${UBL_HEAD}<cbc:ID>`),
    Buffer.from([0xe4]),
    Buffer.from('</cbc:ID></Invoice>'),
  ]);
  assert.deepEqual(read(bad).reasons, ['XML is not valid utf-8']);
});

test('XML that is not well-formed or not an e-invoice goes to review with the reason', () => {
  const reason = (xml) => {
    const r = read(xml);
    assert.equal(r.status, 'review');
    return r.reasons[0];
  };
  assert.match(reason(`${UBL_HEAD}<cbc:ID>1</cbc:Name></Invoice>`), /not well-formed: unexpected <\/cbc:Name>/);
  assert.match(reason(`${UBL_HEAD}<cbc:ID>1</cbc:ID>`), /incomplete/);
  assert.match(reason('<a>1 < 2</a>'), /not well-formed/);
  assert.match(reason('<!DOCTYPE x [<!ENTITY a "b">]><Invoice/>'), /DOCTYPE/);
  assert.match(reason('<Invoice>&foo;</Invoice>'), /unknown entity &foo;/);
  assert.match(reason('<Order><ID>1</ID></Order>'), /not an e-invoice \(root element Order\)/);
  assert.match(reason('<rsm:CrossIndustryDocument xmlns:rsm="x"/>'), /ZUGFeRD 1\.0/);
  assert.match(reason('not xml at all'), /text outside the root element/);
});

test('reads the CII XML embedded in a ZUGFeRD / Factur-X PDF', () => {
  for (const options of [{}, { indirectLength: true }, { compress: false }, { name: 'zugferd-invoice.xml' }]) {
    const r = read(zugferdPdf(cii, options));
    assert.equal(r.status, 'pending', JSON.stringify(options));
    assert.equal(r.source, 'PDF');
    assert.equal(r.syntax, 'CII');
    assert.equal(r.invoice_number, '123456XX');
    assert.equal(r.gross_total, '336.9');
  }
  assert.equal(read(zugferdPdf(ubl, { name: 'xrechnung.xml' })).syntax, 'UBL');
});

test('a PDF without e-invoice XML goes to review', () => {
  const plain = read(plainPdf());
  assert.equal(plain.status, 'review');
  assert.equal(plain.plain_pdf, true);
  const other = read(zugferdPdf('<timesheet><hours>8</hours></timesheet>', { name: 'hours.xml' }));
  assert.deepEqual(other.reasons, ['embedded XML: XML is not an e-invoice (root element timesheet)']);
  const damaged = Buffer.from(zugferdPdf(cii));
  damaged.write('xxxx', damaged.indexOf('stream\n') + 'stream\n'.length + 20, 'latin1');
  assert.match(read(damaged).reasons[0], /^embedded XML: /);
  const encrypted = Buffer.from(
    zugferdPdf(cii).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
    'latin1',
  );
  assert.deepEqual(read(encrypted).reasons, ['PDF is encrypted']);
  assert.deepEqual(read(Buffer.from('<html/>'), { media_type: 'application/pdf' }).reasons, ['file is not a PDF']);
});

test('the inflater handles stored, fixed-code and dynamic-code deflate blocks', () => {
  let x = 1;
  const noise = Array.from({ length: 70000 }, () =>
    String.fromCharCode(97 + (((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16) % 26)),
  ).join('');
  // Over 64 KB, so level 0 needs several stored blocks; the totals at the end of the CII file
  // show that everything up to the end was inflated.
  const big = cii.replace('<rsm:ExchangedDocument>', `<!-- ${noise} ${'a'.repeat(100000)} --><rsm:ExchangedDocument>`);
  for (const xml of [cii, big])
    for (const level of [0, 1, 6, 9]) {
      const r = read(zugferdPdf(xml, { level }));
      assert.equal(r.invoice_number, '123456XX', `level ${level}`);
      assert.equal(r.payable, '336.9', `level ${level}`);
      assert.equal(r.line_count, 2);
    }
  // zlib uses the fixed codes for short input.
  assert.equal(read(zugferdPdf(`${UBL_HEAD}<cbc:ID>7</cbc:ID></Invoice>`)).invoice_number, '7');
});

test('copies of one invoice in an email are read once, and its plain PDF is dropped', () => {
  const email = { message_id: '19a0ff' };
  const out = readFiles([
    fileItem(zugferdPdf(cii), { ...email, file_name: 'RE-123456XX.pdf' }),
    fileItem(cii, { ...email, file_name: 'RE-123456XX.xml' }),
    fileItem(plainPdf(), { ...email, file_name: 'AGB.pdf' }),
    fileItem(plainPdf(), { message_id: '19a100', file_name: 'Angebot.pdf' }),
  ]);
  assert.deepEqual(
    out.map((r) => [r.file_name, r.status]),
    [
      ['RE-123456XX.pdf', 'pending'],
      ['Angebot.pdf', 'review'],
    ],
  );
});
