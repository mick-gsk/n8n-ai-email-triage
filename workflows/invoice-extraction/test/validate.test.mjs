import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { extractions, settings, src } from './helpers.mjs';

const reply = (extraction) => ({
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify(extraction) },
  ],
  stop_reason: 'end_turn',
});

function validateRaw(responses, s = settings) {
  return runCodeNode(src('validate-invoice.js'), {
    input: responses,
    nodes: {
      Settings: [s],
      'Build request': responses.map(() => ({ file: { file_name: 'invoice.pdf', message_id: 'm1' } })),
    },
  });
}
const validate = (extraction, s) => validateRaw([reply(extraction)], s)[0];
const german = (changes) => validate({ ...extractions.germanInvoice, ...changes });

// A receipt with only a total: isolates the parsing of one amount.
const gross = (value, number_format = '1.234,56') =>
  validate({ ...extractions.receipt, vat_lines: [], gross_amount: value, number_format });

describe('Validate', () => {
  test('a German invoice is normalised and passes', () => {
    const inv = validate(extractions.germanInvoice);
    assert.deepEqual(inv.reasons, []);
    assert.equal(inv.status, 'ok');
    assert.equal(inv.file_name, 'invoice.pdf', 'file details from Build request are kept');
    assert.equal(inv.supplier_vat_id, 'DE123456788');
    assert.equal(inv.invoice_date, '2026-10-02');
    assert.equal(inv.due_date, '2026-10-16', 'from the payment terms in days');
    assert.equal(inv.payment_terms_days, 14);
    assert.equal(inv.number_format, '1.234,56');
    assert.equal(inv.currency, 'EUR');
    assert.deepEqual([inv.net_amount, inv.vat_amount, inv.gross_amount], [1250, 237.5, 1487.5]);
    assert.deepEqual(inv.vat_lines, [{ rate: 19, net: 1250, vat: 237.5 }]);
    assert.equal(inv.iban, 'DE89370400440532013000');
    assert.deepEqual(
      inv.line_items.map((l) => l.amount),
      [500, 750],
    );
  });

  test('an English invoice with point decimals and a written-out date passes', () => {
    const inv = validate(extractions.englishInvoice);
    assert.deepEqual(inv.reasons, []);
    assert.equal(inv.invoice_date, '2026-10-05');
    assert.equal(inv.due_date, '2026-11-04');
    assert.deepEqual([inv.net_amount, inv.vat_amount, inv.gross_amount], [1200, 240, 1440]);
  });

  test('a fuel receipt without invoice number or net total passes', () => {
    const inv = validate(extractions.receipt);
    assert.deepEqual(inv.reasons, []);
    assert.equal(inv.invoice_date, '2026-10-07');
    assert.equal(inv.gross_amount, 71.58);
    assert.equal(inv.line_items[0].unit_price, '1,789', 'unit prices stay as printed');
  });

  describe('amounts', () => {
    for (const [printed, format, expected] of [
      ['1.234,56', '1.234,56', 1234.56],
      ['1,234.56', '1,234.56', 1234.56],
      ['1234,56', '1.234,56', 1234.56],
      ['1.234.567,8', '1.234,56', 1234567.8],
      ['1.234', '1.234,56', 1234],
      ['1,234', '1,234.56', 1234],
      ['€ 1.234,56', '1.234,56', 1234.56],
      ['1 234,56 EUR', '1.234,56', 1234.56],
      ["CHF 1'234.50", '1,234.56', 1234.5],
      ['0,99', '1.234,56', 0.99],
    ]) {
      test(`"${printed}" in format ${format} is ${expected}`, () => {
        assert.equal(gross(printed, format).gross_amount, expected);
      });
    }

    for (const [printed, format] of [
      ['1.234,56', '1,234.56'],
      ['12,50', '1,234.56'],
      ['1,234.56', '1.234,56'],
      ['12.5', '1.234,56'],
      ['1.23.456,00', '1.234,56'],
      ['n/a', '1.234,56'],
    ]) {
      test(`"${printed}" does not fit format ${format} and goes to review`, () => {
        const inv = gross(printed, format);
        assert.equal(inv.status, 'review');
        assert.equal(inv.gross_amount, null);
        assert.match(inv.reasons.join(), /gross amount: .* does not match the number format/);
      });
    }

    test('an amount too large to be a number goes to review', () => {
      const inv = gross('9'.repeat(400));
      assert.equal(inv.gross_amount, null);
      assert.match(inv.reasons.join(), /gross amount: .* is not a usable amount/);
    });

    test('missing number format goes to review', () => {
      assert.match(gross('12,50', '').reasons.join(), /number format missing/);
    });
  });

  describe('totals', () => {
    test('net + VAT must equal gross', () => {
      const inv = german({ gross_amount: '1.478,50' });
      assert.equal(inv.status, 'review');
      assert.deepEqual(inv.reasons, ['net 1250.00 + VAT 237.50 = 1487.50, but gross is 1478.50']);
    });

    test('totals that do not reconcile go to review', () => {
      const inv = german({ net_amount: '100,00', vat_amount: '19,00', gross_amount: '1.190,00', vat_lines: [] });
      assert.equal(inv.status, 'review');
      assert.deepEqual(inv.reasons, ['net 100.00 + VAT 19.00 = 119.00, but gross is 1190.00']);
    });

    test('a difference of up to 0.02 is rounding, compared in cents', () => {
      assert.equal(german({ gross_amount: '1.487,52' }).status, 'ok');
      assert.equal(german({ gross_amount: '1.487,53' }).status, 'review');
      // 0.84 + 0.16 - 1.02 is 0.020000000000000018 in floating point.
      const small = german({ net_amount: '0,84', vat_amount: '0,16', gross_amount: '1,02', vat_lines: [] });
      assert.deepEqual(small.reasons, []);
    });

    test('VAT lines are checked against their rate and against the totals', () => {
      const wrongRate = german({ vat_lines: [{ rate: '7 %', net: '1.250,00', vat: '237,50' }] });
      assert.deepEqual(wrongRate.reasons, ['VAT line 1: 7% of 1250.00 is not 237.50']);
      const split = german({
        vat_lines: [
          { rate: '19%', net: '1.000,00', vat: '190,00' },
          { rate: '7%', net: '250,00', vat: '17,50' },
        ],
      });
      assert.match(split.reasons.join(), /VAT lines add up to 207\.50, but VAT total is 237\.50/);
      assert.equal(german({ vat_lines: [{ rate: '119', net: '1', vat: '1' }] }).status, 'review');
    });

    test('a VAT line needs a readable rate', () => {
      for (const r of ['', 'n/a', '19/7']) {
        const inv = german({ vat_lines: [{ rate: r, net: '1.250,00', vat: '237,50' }] });
        assert.deepEqual(inv.reasons, ['VAT line 1: rate missing or unreadable'], r);
      }
      assert.deepEqual(german({ vat_lines: [{ rate: '19,0 %', net: '1.250,00', vat: '237,50' }] }).reasons, []);
    });

    test('an invoice needs net, VAT and gross', () => {
      assert.match(german({ vat_amount: '' }).reasons.join(), /net or VAT amount missing/);
      assert.match(german({ gross_amount: '' }).reasons.join(), /gross amount missing/);
    });

    test('no VAT charged (reverse charge) passes with VAT 0', () => {
      const inv = german({ vat_amount: '0', gross_amount: '1.250,00', vat_lines: [] });
      assert.deepEqual(inv.reasons, []);
      assert.equal(inv.vat_amount, 0);
    });

    test('a negative total on an invoice goes to review', () => {
      const inv = german({ net_amount: '-1.250,00', vat_amount: '-237,50', gross_amount: '-1.487,50', vat_lines: [] });
      assert.match(inv.reasons.join(), /negative total on an invoice/);
    });
  });

  describe('credit notes', () => {
    test('amounts printed as positive are stored as negative', () => {
      const inv = validate(extractions.creditNote);
      assert.deepEqual(inv.reasons, []);
      assert.deepEqual([inv.net_amount, inv.vat_amount, inv.gross_amount], [-150, -28.5, -178.5]);
      assert.deepEqual(inv.vat_lines, [{ rate: 19, net: -150, vat: -28.5 }]);
      assert.equal(inv.line_items[0].amount, -150);
    });

    test('amounts printed with a leading or trailing minus or in brackets stay negative', () => {
      for (const [net, vat, gross] of [
        ['-150,00', '-28,50', '-178,50'],
        ['150,00-', '28,50-', '178,50-'],
        ['(150,00)', '(28,50)', '(178,50)'],
      ]) {
        const inv = validate({
          ...extractions.creditNote,
          net_amount: net,
          vat_amount: vat,
          gross_amount: gross,
          vat_lines: [],
          line_items: [],
        });
        assert.deepEqual(inv.reasons, [], net);
        assert.deepEqual([inv.net_amount, inv.vat_amount, inv.gross_amount], [-150, -28.5, -178.5]);
      }
    });

    test('mixed signs go to review', () => {
      const inv = validate({ ...extractions.creditNote, net_amount: '-150,00', vat_lines: [] });
      assert.match(inv.reasons.join(), /mixed signs/);
    });
  });

  describe('dates', () => {
    for (const [printed, expected] of [
      ['2026-10-02', '2026-10-02'],
      ['2.10.2026', '2026-10-02'],
      ['02.10.26', '2026-10-02'],
      ['2. Oktober 2026', '2026-10-02'],
      ['02. Okt. 2026', '2026-10-02'],
      ['2 October 2026', '2026-10-02'],
      ['Oct 2, 2026', '2026-10-02'],
      ['15. Jänner 2026', '2026-01-15'],
      ['3. März 2026', '2026-03-03'],
      ['02/10/2026', '2026-10-02'],
      ['10/13/2026', '2026-10-13'],
    ]) {
      test(`"${printed}" is ${expected}`, () => {
        const inv = german({ invoice_date: printed, payment_terms_days: '' });
        assert.equal(inv.invoice_date, expected);
      });
    }

    test('slash dates follow the dateOrder setting when both orders are possible', () => {
      const inv = validate(
        { ...extractions.germanInvoice, invoice_date: '02/10/2026', payment_terms_days: '' },
        { ...settings, dateOrder: 'MDY' },
      );
      assert.equal(inv.invoice_date, '2026-02-10');
    });

    test('impossible or unreadable dates go to review', () => {
      for (const printed of ['31.02.2026', '2026-13-01', 'last Tuesday', '13/13/2026']) {
        const inv = german({ invoice_date: printed });
        assert.equal(inv.status, 'review', printed);
        assert.match(inv.reasons.join(), /invoice date: .* is not a date/);
      }
    });

    test('payment terms are kept as a whole number of days or go to review', () => {
      assert.equal(german({ payment_terms_days: '' }).payment_terms_days, null);
      const immediate = german({ payment_terms_days: '0' });
      assert.deepEqual([immediate.payment_terms_days, immediate.due_date], [0, '2026-10-02']);
      const printed = german({ payment_terms_days: '30', due_date: '20.10.2026' });
      assert.deepEqual([printed.payment_terms_days, printed.due_date], [30, '2026-10-20'], 'a printed date wins');
      for (const terms of ['14 Tage', '-5', '1.5', '400']) {
        const inv = german({ payment_terms_days: terms });
        assert.equal(inv.payment_terms_days, null, terms);
        assert.deepEqual(inv.reasons, [`payment terms "${terms}" are not a number of days`], terms);
      }
    });

    test('due date before invoice date goes to review', () => {
      const inv = german({ due_date: '01.10.2026' });
      assert.deepEqual(inv.reasons, ['due date 2026-10-01 is before invoice date 2026-10-02']);
    });

    test('an invoice dated in the future goes to review', () => {
      const next = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
      assert.match(german({ invoice_date: next }).reasons.join(), /is in the future/);
    });

    test('a missing invoice date goes to review', () => {
      assert.match(german({ invoice_date: '' }).reasons.join(), /invoice date missing/);
    });
  });

  describe('IBAN and VAT ID', () => {
    test('IBANs of common countries pass the mod 97 check', () => {
      for (const iban of ['DE89 3704 0044 0532 0130 00', 'AT61 1904 3002 3457 3201', 'CH93 0076 2011 6238 5295 7']) {
        assert.deepEqual(german({ iban }).reasons, [], iban);
      }
    });

    test('a mistyped or wrong-length IBAN goes to review', () => {
      assert.deepEqual(german({ iban: 'DE89 3704 0044 0532 0130 01' }).reasons, [
        'IBAN DE89370400440532013001 is not valid',
      ]);
      assert.equal(german({ iban: 'DE89 3704 0044 0532 0130' }).status, 'review');
      assert.equal(german({ iban: 'not an iban' }).status, 'review');
    });

    test('IBAN lengths are checked for every registry country', () => {
      for (const iban of [
        'AD12 0001 2030 2003 5910 0100',
        'SM86 U032 2509 8000 0000 0270 100',
        'VA59 0011 2300 0012 3456 78',
        'AL47 2121 1009 0000 0002 3569 8741',
        'ME25 5050 0001 2345 6789 51',
        'MK07 2501 2000 0058 984',
        'MD24 AG00 0225 1000 1310 4168',
        'RS35 2600 0560 1001 6113 79',
      ]) {
        assert.deepEqual(german({ iban }).reasons, [], iban);
      }
      // Both pass the mod 97 check: AD needs 24 characters, and US has no IBANs.
      assert.deepEqual(german({ iban: 'AD8112345678901' }).reasons, ['IBAN AD8112345678901 is not valid']);
      assert.equal(german({ iban: 'US561234567890123456789' }).status, 'review');
    });

    test('VAT IDs are checked against the country format', () => {
      for (const id of ['ATU12345678', 'NL123456789B01', 'FR12345678901', 'CHE-123.456.789 MWST', 'BE0123456789']) {
        assert.deepEqual(german({ supplier_vat_id: id }).reasons, [], id);
      }
      for (const id of ['NL123456789', 'ATU1234567', 'FR1234567890', '123456789']) {
        assert.equal(german({ supplier_vat_id: id }).status, 'review', id);
      }
    });

    test('a German VAT ID with a wrong check digit goes to review', () => {
      assert.deepEqual(german({ supplier_vat_id: 'DE123456789' }).reasons, [
        'VAT ID "DE123456789" has a wrong check digit',
      ]);
    });
  });

  describe('everything else', () => {
    test('a document that is not an invoice is marked as such', () => {
      const inv = validate(extractions.notAnInvoice);
      assert.equal(inv.status, 'not_invoice');
      assert.deepEqual(inv.reasons, ['not an invoice, credit note or receipt']);
    });

    test('fields the model could not read go to review', () => {
      const inv = german({ uncertain_fields: ['gross_amount', 'iban'] });
      assert.deepEqual(inv.reasons, ['unclear on the document: gross_amount, iban']);
    });

    test('supplier and invoice number are required', () => {
      const inv = german({ supplier_name: ' ', invoice_number: '' });
      assert.deepEqual(inv.reasons, ['supplier name missing', 'invoice number missing']);
    });

    test('unambiguous currency symbols become ISO codes; anything else goes to review', () => {
      assert.equal(german({ currency: '€' }).currency, 'EUR');
      assert.equal(german({ currency: 'US$' }).currency, 'USD');
      assert.deepEqual(german({ currency: 'chf' }).reasons, []);
      for (const c of ['Euro', '$', 'kr', '¥', 'XYZ']) {
        const inv = german({ currency: c });
        assert.deepEqual(inv.reasons, [`currency "${c.toUpperCase()}" is not an ISO 4217 code`], c);
      }
    });

    test('an unknown document type goes to review', () => {
      assert.match(german({ document_type: 'quote' }).reasons.join(), /unknown document type "quote"/);
    });

    test('text fields are clamped and line items capped', () => {
      const many = Array.from({ length: 150 }, () => ({
        description: 'x',
        quantity: '1',
        unit_price: '1',
        amount: '',
      }));
      const inv = german({ supplier_name: 'A'.repeat(1000), line_items: many });
      assert.equal(inv.supplier_name.length, 200);
      assert.equal(inv.line_items.length, 100);
    });

    test('API errors, refusals, cut-off and malformed replies go to review', () => {
      const out = validateRaw([
        { error: { message: 'overloaded' } },
        { content: [], stop_reason: 'refusal' },
        { content: [{ type: 'text', text: '{"document_type": "inv' }], stop_reason: 'max_tokens' },
        { content: [{ type: 'text', text: 'I cannot read this file.' }], stop_reason: 'end_turn' },
      ]);
      assert.deepEqual(
        out.map((o) => [o.status, o.reasons[0]]),
        [
          ['review', 'API error: overloaded'],
          ['review', 'model declined to read the document'],
          ['review', 'model reply cut off at max_tokens'],
          ['review', 'no JSON object in model reply'],
        ],
      );
      assert.equal(out[0].file_name, 'invoice.pdf');
    });
  });
});
