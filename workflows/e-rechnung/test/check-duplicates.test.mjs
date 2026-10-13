import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { src } from './helpers.mjs';

const ok = (changes = {}) => ({
  status: 'ok',
  reasons: [],
  message_id: '19a0f1',
  seller_name: 'Kornblume Bäckerei GmbH',
  seller_vat_id: 'DE123456789',
  invoice_number: 'RE-2026-0042',
  iban: 'DE79000000001234567890',
  ...changes,
});

const run = (records, sheet = [{}]) =>
  runCodeNode(src('check-duplicates.js'), { input: sheet, nodes: { 'Collect results': records } });

test('an invoice already in the sheet is a duplicate', () => {
  const [r] = run(
    [ok()],
    [{ row_number: 7, ...ok({ invoice_number: 're 2026/0042', seller_vat_id: 'DE 123 456 789' }) }],
  );
  assert.equal(r.status, 'duplicate');
  assert.equal(r.reason, 'same seller and invoice number as row 7 of the Invoices sheet');
});

test('the same number from another seller is not a duplicate', () => {
  const [r] = run([ok()], [{ row_number: 7, ...ok({ seller_vat_id: 'DE987654321', iban: '' }) }]);
  assert.equal(r.status, 'ok');
});

test('without VAT IDs the seller is compared by name, legal form ignored', () => {
  const [r] = run(
    [ok({ seller_vat_id: '' })],
    [{ row_number: 3, ...ok({ seller_vat_id: '', seller_name: 'Kornblume Bäckerei' }) }],
  );
  assert.equal(r.status, 'duplicate');
});

test('a changed IBAN of a known seller goes to review', () => {
  const [r] = run(
    [ok({ invoice_number: 'RE-2026-0043', iban: 'DE89370400440532013000' })],
    [{ row_number: 2, ...ok() }],
  );
  assert.equal(r.status, 'review');
  assert.match(r.reason, /IBAN differs from earlier invoices of this seller \(DE79000000001234567890\)/);
});

test('the second copy within one run is a duplicate; review items pass through', () => {
  const out = run([ok(), ok({ message_id: '19a0f2' }), { status: 'review', reasons: ['PDF is encrypted'] }]);
  assert.deepEqual(
    out.map((r) => [r.status, r.reason]),
    [
      ['ok', ''],
      ['duplicate', 'same seller and invoice number as another email in this run'],
      ['review', 'PDF is encrypted'],
    ],
  );
});
