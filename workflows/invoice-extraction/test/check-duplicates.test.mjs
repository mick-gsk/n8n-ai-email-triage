import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { ok, src } from './helpers.mjs';

function dedupe(results, rows) {
  return runCodeNode(src('check-duplicates.js'), { input: rows, nodes: { 'Collect results': results } });
}

describe('Check duplicates', () => {
  test('a new invoice stays ok; an empty sheet is fine', () => {
    assert.equal(dedupe([ok()], [{}])[0].status, 'ok');
  });

  test('same supplier and number as a sheet row is a duplicate, despite spelling', () => {
    const row = {
      row_number: 7,
      supplier_name: 'MUSTER Bürobedarf',
      supplier_vat_id: '',
      invoice_number: 'RE 2026/0042',
    };
    const [out] = dedupe([ok({ supplier_vat_id: '' })], [row]);
    assert.equal(out.status, 'duplicate');
    assert.equal(out.reason, 'same supplier and invoice number as row 7 of the Invoices sheet');
  });

  test('VAT IDs decide when both sides have one', () => {
    const row = {
      row_number: 7,
      supplier_name: 'Muster Bürobedarf GmbH',
      supplier_vat_id: 'DE111222339',
      invoice_number: 'RE-2026-0042',
    };
    assert.equal(dedupe([ok()], [row])[0].status, 'ok', 'a different company with the same name');
    const renamed = { ...row, supplier_name: 'Muster Office Supplies', supplier_vat_id: 'DE 123 456 788' };
    assert.equal(dedupe([ok()], [renamed])[0].status, 'duplicate');
  });

  test('the same invoice twice in one run: the second is the duplicate', () => {
    const out = dedupe([ok(), ok()], [{}]);
    assert.deepEqual(
      out.map((o) => o.status),
      ['ok', 'duplicate'],
    );
    assert.match(out[1].reason, /another file in this run/);
  });

  test('receipts without a number match on supplier, date and total', () => {
    const receipt = ok({
      document_type: 'receipt',
      invoice_number: '',
      supplier_vat_id: '',
      supplier_name: 'Tankstelle am Ring',
      gross_amount: 71.58,
    });
    const row = {
      row_number: 4,
      supplier_name: 'Tankstelle am Ring',
      invoice_number: '',
      invoice_date: '2026-10-02',
      gross_amount: '71.58',
    };
    assert.match(dedupe([receipt], [row])[0].reason, /same supplier, date and total as row 4/);
    assert.equal(dedupe([{ ...receipt, gross_amount: 20 }], [row])[0].status, 'ok');
  });

  test('a changed IBAN for a known supplier goes to review', () => {
    const row = {
      row_number: 2,
      supplier_name: 'Muster Bürobedarf GmbH',
      supplier_vat_id: 'DE123456788',
      invoice_number: 'RE-2026-0041',
      iban: 'AT611904300234573201',
    };
    const [out] = dedupe([ok()], [row]);
    assert.equal(out.status, 'review');
    assert.equal(out.reason, 'IBAN differs from earlier invoices of this supplier (AT611904300234573201)');
  });

  test('items already in review are passed on unchanged, with their reasons as one line', () => {
    const [out] = dedupe([{ status: 'review', reasons: ['a', 'b'], file_name: 'x.pdf' }], [{}]);
    assert.equal(out.status, 'review');
    assert.equal(out.reason, 'a; b');
  });
});
