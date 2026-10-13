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

describe('Validate', () => {
  test('a well-formed reply becomes a record with the file details', () => {
    const inv = validate(extractions.germanInvoice);
    assert.deepEqual(inv.reasons, []);
    assert.equal(inv.status, 'ok');
    assert.equal(inv.file_name, 'invoice.pdf', 'file details from Build request are kept');
    assert.equal(inv.supplier_name, 'Muster Bürobedarf GmbH');
    assert.equal(inv.invoice_number, 'RE-2026-0042');
    assert.equal(inv.line_items.length, 2);
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
