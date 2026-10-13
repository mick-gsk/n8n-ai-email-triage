import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { check, src, ubl } from './helpers.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = JSON.parse(read('../workflow.json'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const settings = JSON.parse(byName.Settings.parameters.jsonOutput);
const targets = (from, output = 0) => workflow.connections[from].main[output].map((c) => `${c.node}:${c.index}`);

test('workflow.json is in sync with src/ (run npm run build)', () => {
  for (const [name, file] of [
    ['Split attachments', 'split-attachments.js'],
    ['Read e-invoice', 'read-einvoice.js'],
    ['Validate', 'validate-einvoice.js'],
    ['Check duplicates', 'check-duplicates.js'],
    ['Prepare rows', 'prepare-rows.js'],
  ]) {
    assert.equal(byName[name].parameters.jsCode, read(`../src/${file}`), name);
  }
});

test('no AI or HTTP step: the invoice data comes from the XML only', () => {
  const types = new Set(workflow.nodes.map((n) => n.type));
  assert.ok(![...types].some((t) => /langchain|httpRequest|openAi|anthropic/i.test(t)), [...types].join(', '));
});

test('the Code nodes use no modules, so they run without NODE_FUNCTION_ALLOW_BUILTIN', () => {
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code'))
    assert.doesNotMatch(n.parameters.jsCode, /\brequire\s*\(|\bimport\s*\(/, n.name);
});

test('the trigger downloads attachments and limits emails per poll', () => {
  const { parameters } = byName['Gmail Trigger'];
  assert.equal(parameters.simple, false);
  assert.equal(parameters.options.downloadAttachments, true);
  assert.ok(parameters.maxResults > 0 && parameters.maxResults <= 50);
  assert.match(parameters.filters.q, /has:attachment/);
});

test('the file content reaches the Code node in any binary data mode, and stays attached', () => {
  const { parameters } = byName['Read file'];
  assert.equal(parameters.operation, 'binaryToPropery');
  assert.equal(parameters.destinationKey, 'fileBase64');
  assert.equal(parameters.options.keepSource, 'both');
});

test('emails without a usable file join the results instead of being dropped', () => {
  assert.deepEqual(targets('XML or PDF?', 0), ['Read file:0']);
  assert.deepEqual(targets('XML or PDF?', 1), ['Collect results:1']);
  assert.deepEqual(targets('Validate'), ['Collect results:0']);
});

test('everything that is not ok goes to Slack, the Review tab and a Gmail label', () => {
  assert.deepEqual(targets('Valid?', 0), ['File in Drive?:0']);
  assert.deepEqual(targets('Valid?', 1).sort(), ['Append to Review:0', 'Label for review:0', 'Post to Slack:0']);
  assert.equal(byName['Valid?'].parameters.conditions.conditions[0].rightValue, 'ok');
});

test('Drive is optional, and the processed label is set only after the row is written', () => {
  assert.deepEqual(targets('File in Drive?', 0), ['Upload to Drive:0']);
  assert.deepEqual(targets('File in Drive?', 1), ['Prepare rows:0']);
  assert.deepEqual(targets('Upload to Drive'), ['Prepare rows:0']);
  assert.deepEqual(targets('Prepare rows'), ['Append to Invoices:0']);
  assert.deepEqual(targets('Append to Invoices'), ['Label as processed:0']);
});

test('the duplicate lookup runs once and still continues on an empty sheet', () => {
  const lookup = byName['Read existing invoices'];
  assert.equal(lookup.executeOnce, true);
  assert.equal(lookup.alwaysOutputData, true);
});

test('Google Sheets writes values as they are, not as formulas', () => {
  for (const name of ['Append to Invoices', 'Append to Review'])
    assert.equal(byName[name].parameters.options.cellFormat, 'RAW', name);
});

test('the Invoices columns are exactly what Prepare rows produces, with or without Drive', () => {
  const record = check(ubl);
  for (const driveFolderId of ['folder', '']) {
    const [row] = runCodeNode(src('prepare-rows.js'), {
      input: [driveFolderId ? { id: 'file-1' } : record],
      nodes: { 'Check duplicates': [record], Settings: [{ driveFolderId }] },
    });
    const columns = byName['Append to Invoices'].parameters.columns;
    assert.deepEqual(Object.keys(columns.value), Object.keys(row));
    assert.equal(row.file_link, driveFolderId ? 'https://drive.google.com/file/d/file-1/view' : '');
    assert.equal(row.vat_breakdown, 'S 7%: 314.86 + 22.04');
    assert.deepEqual(
      columns.schema.filter((c) => c.type === 'number').map((c) => c.id),
      ['net_amount', 'vat_amount', 'gross_amount', 'payable_amount'],
    );
  }
});

// Evaluates an n8n expression string ("=...{{ js }}...") for one item, enough for simple templates.
const render = (expr, json) =>
  expr.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, js) => new Function('$json', `return (${js});`)(json));

test('the Slack message escapes invoice and email fields', () => {
  const text = render(byName['Post to Slack'].parameters.text, {
    status: 'review',
    file_name: '<!channel>.xml',
    email_from: 'x@example.com',
    reason: 'IBAN differs; <https://evil.example|pay here> & more',
    gmail_link: 'https://mail.google.com/mail/u/0/#all/19a0f1',
  });
  assert.doesNotMatch(text, /<!channel>|<https:\/\/evil/);
  assert.match(text, /&lt;!channel&gt;\.xml/);
  assert.match(text, /&amp; more/);
  assert.match(text, /<https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/19a0f1\|Open the email>$/);
});

test('Settings uses placeholders that are easy to spot', () => {
  assert.match(settings.sheetId, /^YOUR_/);
  assert.match(settings.driveFolderId, /^YOUR_/);
  assert.ok(settings.maxFileMB > 0);
});
