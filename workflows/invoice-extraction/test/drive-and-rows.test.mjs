import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { ok, src } from './helpers.mjs';

describe('Plan folders, Attach folder, Prepare rows', () => {
  const checked = [
    {
      json: ok({ invoice_date: '2026-10-02', media_type: 'application/pdf', file_name: 'a.pdf' }),
      binary: { file: { id: 'a' } },
    },
    {
      json: ok({ invoice_date: '2026-09-28', invoice_number: 'RE/41', media_type: 'image/jpeg', file_name: 'b.jpg' }),
      binary: { file: { id: 'b' } },
    },
    { json: { status: 'review', reasons: ['x'], invoice_date: '2026-08-01' } },
  ];

  test('one item per month of a valid invoice, with the folder ID if the folder exists', () => {
    const out = runCodeNode(src('plan-folders.js'), {
      input: [
        { id: 'f9', name: '2026-09' },
        { id: 'other', name: 'Archive' },
      ],
      nodes: { 'Check duplicates': checked.map((c) => c.json) },
    });
    assert.deepEqual(out, [
      { month: '2026-09', folder_id: 'f9' },
      { month: '2026-10', folder_id: '' },
    ]);
  });

  test('valid files get their folder and a sortable file name', () => {
    const out = runCodeNode(src('attach-folder.js'), {
      items: true,
      input: [
        { json: { id: 'f10', name: '2026-10', mimeType: 'application/vnd.google-apps.folder' } },
        { json: { month: '2026-09', folder_id: 'f9' } },
      ],
      nodes: { 'Check duplicates': checked },
    });
    assert.deepEqual(
      out.map((o) => [o.json.folder_id, o.json.drive_file_name, o.binary.file.id]),
      [
        ['f10', '2026-10-02 Muster Bürobedarf GmbH RE-2026-0042.pdf', 'a'],
        ['f9', '2026-09-28 Muster Bürobedarf GmbH RE 41.jpg', 'b'],
      ],
    );
  });

  test('a month without a folder stops the run', () => {
    assert.throws(
      () => runCodeNode(src('attach-folder.js'), { items: true, input: [], nodes: { 'Check duplicates': checked } }),
      /no Drive folder for 2026-10/,
    );
  });

  test('rows get a link to the uploaded file', () => {
    const attached = [
      ok({
        vat_lines: [
          { rate: 19, net: 1000, vat: 190 },
          { rate: 7, net: 250, vat: 17.5 },
        ],
        line_items: [{ description: 'Toner', quantity: '1', unit_price: '750,00', amount: 750 }],
      }),
    ];
    const [row] = runCodeNode(src('prepare-rows.js'), {
      input: [{ id: '1AbC', name: 'x.pdf' }],
      nodes: { 'Attach folder': attached },
    });
    assert.equal(row.file_link, 'https://drive.google.com/file/d/1AbC/view');
    assert.equal(row.vat_rates, '19%: 190; 7%: 17.5');
    assert.deepEqual(JSON.parse(row.line_items), attached[0].line_items);
    assert.equal(row.gross_amount, 1487.5);
  });
});
