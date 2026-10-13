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
    assert.equal(inv.invoice_date, '2026-10-02');
    assert.equal(inv.due_date, '2026-10-16', 'from the payment terms in days');
    assert.equal(inv.currency, 'EUR');
    assert.deepEqual([inv.net_amount, inv.vat_amount, inv.gross_amount], [1250, 237.5, 1487.5]);
    assert.deepEqual(inv.vat_lines, [{ rate: 19, net: 1250, vat: 237.5 }]);
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

    test('a difference of up to 0.02 is rounding', () => {
      assert.equal(german({ gross_amount: '1.487,52' }).status, 'ok');
      assert.equal(german({ gross_amount: '1.487,53' }).status, 'review');
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

    test('currency symbols become ISO codes; anything else goes to review', () => {
      assert.equal(german({ currency: '€' }).currency, 'EUR');
      assert.match(german({ currency: 'Euro' }).reasons.join(), /currency "EURO" is not an ISO code/);
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
