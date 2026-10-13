import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { broken, check, cii, fixture, fixtures, src, ubl, zugferdPdf } from './helpers.mjs';

/** 01.01a with one value replaced (in UBL or CII). */
const reasons = (xml, from, to) => {
  assert.ok(xml.includes(from), from);
  return check(xml.replace(from, to)).reasons;
};

test('every test suite invoice is accepted (the KoSIT validator accepts them all)', () => {
  for (const f of fixtures) {
    const r = check(fixture(f));
    assert.deepEqual(r.reasons, [], f);
    assert.equal(r.status, 'ok', f);
  }
});

test('the record has the amounts as numbers and the fields for the sheet', () => {
  const r = check(ubl, { file_name: 'RE-123456XX.xml' });
  assert.equal(r.format, 'XRechnung UBL');
  assert.equal(r.document_type, 'invoice');
  assert.equal(r.seller_vat_id, 'DE123456789');
  assert.equal(r.seller_address, '[Seller address line 1], 12345 [Seller city], DE');
  assert.deepEqual([r.net_amount, r.vat_amount, r.gross_amount, r.payable_amount], [314.86, 22.04, 336.9, 336.9]);
  assert.deepEqual(r.vat_breakdown, [{ category: 'S', rate: 7, basis: 314.86, vat: 22.04 }]);
  assert.equal(r.line_items.length, 2);
  assert.equal(r.line_items[0].amount, 288.79);
  assert.equal(r.drive_file_name, '2016-04-04 [Seller name] 123456XX.xml');
  assert.equal(r.file_name, 'RE-123456XX.xml');
  assert.equal(check(cii).format, 'XRechnung CII');
  const pdf = check(zugferdPdf(cii));
  assert.equal(pdf.format, 'ZUGFeRD PDF (CII)');
  assert.equal(pdf.drive_file_name, '2016-04-04 [Seller name] 123456XX.pdf');
});

test('the broken copies go to review with the reason, in UBL and CII', () => {
  const expected = {
    'wrong gross': ['net 314.86 + VAT 22.04 = 336.90, but gross is 363.90'],
    'wrong VAT breakdown': [
      'VAT breakdown 1: 7% of 314.86 is not 20.04',
      'VAT breakdown adds up to 20.04, but the VAT total is 22.04',
    ],
    'bad IBAN': ['IBAN DE79000000001234567891 is not valid'],
    'no invoice number': ['invoice number (BT-1) missing'],
  };
  for (const [name, breakIt] of Object.entries(broken))
    for (const xml of [ubl, cii]) {
      const r = check(breakIt(xml));
      assert.equal(r.status, 'review', name);
      assert.deepEqual(r.reasons, expected[name], name);
    }
});

test('the sum rules are checked in whole cents', () => {
  assert.deepEqual(
    reasons(
      ubl,
      '<cbc:LineExtensionAmount currencyID="EUR">26.07<',
      '<cbc:LineExtensionAmount currencyID="EUR">26.08<',
    ),
    ['lines add up to 314.87, but the line total (BT-106) is 314.86'],
  );
  assert.deepEqual(
    reasons(
      ubl,
      '<cbc:TaxExclusiveAmount currencyID="EUR">314.86<',
      '<cbc:TaxExclusiveAmount currencyID="EUR">314.85<',
    ),
    [
      'line total 314.86 - allowances 0.00 + charges 0.00 is not the net total 314.85',
      'net 314.85 + VAT 22.04 = 336.89, but gross is 336.90',
      'VAT breakdown taxable amounts add up to 314.86, but the net total is 314.85',
    ],
  );
  assert.deepEqual(reasons(cii, '<ram:DuePayableAmount>336.9<', '<ram:DuePayableAmount>336.8<'), [
    'gross 336.90 - prepaid 0.00 + rounding 0.00 is not the amount due 336.80',
  ]);
  assert.deepEqual(reasons(cii, '<ram:GrandTotalAmount>336.9<', '<ram:GrandTotalAmount>336.901<'), [
    'gross total (BT-112) "336.901" is not an amount with at most 2 decimals',
  ]);
  // A prepaid amount is subtracted.
  assert.deepEqual(
    reasons(
      cii,
      '<ram:DuePayableAmount>336.9<',
      '<ram:TotalPrepaidAmount>100.00</ram:TotalPrepaidAmount><ram:DuePayableAmount>236.9<',
    ),
    [],
  );
});

test('the VAT amount per category may differ from basis x rate by less than one unit', () => {
  // EN 16931 (BR-S-09) allows it; the VAT total must still match the breakdown and the gross.
  const shifted = ubl
    .replace(/22\.04/g, '22.90')
    .replace(/(<cbc:(TaxInclusiveAmount|PayableAmount)[^>]*>)336\.9/g, '$1337.76');
  assert.deepEqual(check(shifted).reasons, []);
  const tooFar = ubl
    .replace(/22\.04/g, '23.04')
    .replace(/(<cbc:(TaxInclusiveAmount|PayableAmount)[^>]*>)336\.9/g, '$1337.9');
  assert.deepEqual(check(tooFar).reasons, ['VAT breakdown 1: 7% of 314.86 is not 23.04']);
  assert.deepEqual(
    reasons(
      cii,
      '<ram:CategoryCode>S</ram:CategoryCode>\n                <ram:RateApplicablePercent>7',
      '<ram:CategoryCode>AE</ram:CategoryCode>\n                <ram:RateApplicablePercent>7',
    ),
    ['VAT breakdown 1: category AE needs VAT 0, not 22.04'],
  );
});

test('a credit note is stored with negative amounts', () => {
  const r = check(cii.replace('<ram:TypeCode>380</ram:TypeCode>', '<ram:TypeCode>381</ram:TypeCode>'));
  assert.equal(r.status, 'ok');
  assert.equal(r.document_type, 'credit_note');
  assert.deepEqual([r.net_amount, r.vat_amount, r.gross_amount], [-314.86, -22.04, -336.9]);
  assert.equal(r.vat_breakdown[0].vat, -22.04);
  assert.equal(r.line_items[0].amount, -288.79);
});

test('required business terms, type code, currency and dates', () => {
  assert.deepEqual(reasons(ubl, '<cbc:InvoiceTypeCode>380<', '<cbc:InvoiceTypeCode>220<'), [
    'invoice type code "220" is not one of 326, 380, 381, 384, 389, 875, 876, 877',
  ]);
  assert.deepEqual(reasons(ubl, '<cbc:DocumentCurrencyCode>EUR<', '<cbc:DocumentCurrencyCode>€<'), [
    'currency "€" is not an ISO 4217 code',
  ]);
  assert.deepEqual(reasons(ubl, '<cbc:IssueDate>2016-04-04<', '<cbc:IssueDate>2016-02-30<'), [
    'issue date (BT-2) "2016-02-30" is not a date',
  ]);
  assert.deepEqual(reasons(cii, 'format="102">20160404<', 'format="102">20990404<'), [
    'issue date 2099-04-04 is in the future',
  ]);
  assert.deepEqual(
    reasons(
      ubl,
      '<cbc:IssueDate>2016-04-04</cbc:IssueDate>',
      '<cbc:IssueDate>2016-04-04</cbc:IssueDate><cbc:DueDate>2016-03-01</cbc:DueDate>',
    ),
    ['due date 2016-03-01 is before issue date 2016-04-04'],
  );
  assert.deepEqual(reasons(ubl, '<cbc:Note>Zahlbar sofort ohne Abzug.</cbc:Note>', ''), [
    'neither due date (BT-9) nor payment terms (BT-20)',
  ]);
  assert.deepEqual(reasons(ubl, '<cbc:RegistrationName>[Buyer name]<', '<cbc:RegistrationName><'), [
    'buyer name (BT-44) missing',
  ]);
  assert.deepEqual(reasons(cii, '<ram:ID schemeID="VA">DE 123456789</ram:ID>', ''), [
    'seller VAT ID (BT-31) and tax number (BT-32) missing',
  ]);
});

test('IBAN: checksum and length, and SEPA credit transfer needs one', () => {
  assert.deepEqual(reasons(ubl, 'DE79000000001234567890', 'DE7900000000123456789'), [
    'IBAN DE7900000000123456789 is not valid',
  ]);
  assert.deepEqual(reasons(cii, '<ram:IBANID>DE79000000001234567890<', '<ram:IBANID><'), [
    'SEPA credit transfer (58) without IBAN (BT-84)',
  ]);
  assert.equal(
    check(ubl.replace('DE79000000001234567890', 'DE79 0000 0000 1234 5678 90')).iban,
    'DE79000000001234567890',
  );
});

test('ZUGFeRD MINIMUM and BASIC WL are not accepted as e-invoices', () => {
  const minimum = cii.replace(
    'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    'urn:factur-x.eu:1p0:minimum',
  );
  assert.deepEqual(check(zugferdPdf(minimum)).reasons, [
    'profile urn:factur-x.eu:1p0:minimum is below EN 16931 (no line items), check the invoice by hand',
  ]);
});

test('files that could not be read keep their status and reason', () => {
  const [r] = runCodeNode(src('validate-einvoice.js'), {
    input: [{ message_id: 'x', file_name: 'a.pdf', status: 'review', reasons: ['PDF is encrypted'] }],
  });
  assert.equal(r.status, 'review');
  assert.deepEqual(r.reasons, ['PDF is encrypted']);
  assert.equal(r.message_id, 'x');
});
