import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = JSON.parse(read('../workflow.json'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const settings = JSON.parse(byName.Settings.parameters.jsonOutput);
const targets = (from, output = 0) => workflow.connections[from].main[output].map((c) => `${c.node}:${c.index}`);

test('workflow.json is in sync with src/ (run npm run build)', () => {
  for (const [name, file] of [
    ['Split attachments', 'split-attachments.js'],
    ['Build request', 'build-request.js'],
    ['Validate', 'validate-invoice.js'],
    ['Check duplicates', 'check-duplicates.js'],
    ['Plan folders', 'plan-folders.js'],
    ['Attach folder', 'attach-folder.js'],
    ['Prepare rows', 'prepare-rows.js'],
  ]) {
    assert.equal(byName[name].parameters.jsCode, read(`../src/${file}`), name);
  }
  assert.equal(settings.systemPrompt, read('../src/prompt.md').trim());
  assert.deepEqual(settings.outputSchema, JSON.parse(read('../src/schema.json')));
});

test('the schema and the validation agree on document types and fields', () => {
  const schema = settings.outputSchema;
  const types = read('../src/validate-invoice.js')
    .match(/const TYPES = \[([^\]]+)\]/)[1]
    .match(/'(\w+)'/g)
    .map((s) => s.slice(1, -1));
  assert.deepEqual(schema.properties.document_type.enum, types);
  for (const f of schema.properties.uncertain_fields.items.enum) assert.ok(f in schema.properties, f);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
});

test('the trigger downloads attachments and limits emails per poll', () => {
  const { parameters } = byName['Gmail Trigger'];
  assert.equal(parameters.simple, false);
  assert.equal(parameters.options.downloadAttachments, true);
  assert.ok(parameters.maxResults > 0 && parameters.maxResults <= 50);
  assert.match(parameters.filters.q, /has:attachment/);
});

test('Ask Claude retries, times out and hands failures on instead of stopping', () => {
  const ask = byName['Ask Claude'];
  assert.equal(ask.retryOnFail, true);
  assert.ok(ask.maxTries >= 3 && ask.maxTries <= 5, 'n8n allows 2 to 5 tries');
  assert.ok(ask.waitBetweenTries > 0 && ask.waitBetweenTries <= 5000, 'n8n caps the wait at 5000 ms');
  assert.equal(ask.onError, 'continueRegularOutput', 'a failed file must still reach review');
  assert.ok(ask.parameters.options.timeout >= 60000);
  assert.ok(ask.parameters.options.batching.batch.batchSize > 0);
});

test('files that skip Claude join the results instead of being dropped', () => {
  assert.deepEqual(targets('Readable file?', 0), ['Read file:0']);
  assert.deepEqual(targets('Readable file?', 1), ['Collect results:1']);
  assert.deepEqual(targets('Validate'), ['Collect results:0']);
  assert.deepEqual(targets('Folder missing?', 1), ['Merge folders:1']);
});

test('everything that is not ok goes to Slack, the Review tab and a Gmail label', () => {
  assert.deepEqual(targets('Valid?', 0), ['Find month folders:0']);
  assert.deepEqual(targets('Valid?', 1).sort(), ['Append to Review:0', 'Label for review:0', 'Post to Slack:0']);
  assert.equal(byName['Valid?'].parameters.conditions.conditions[0].rightValue, 'ok');
});

test('the processed label is set only after the row is written', () => {
  assert.deepEqual(targets('Upload to Drive'), ['Prepare rows:0']);
  assert.deepEqual(targets('Prepare rows'), ['Append to Invoices:0']);
  assert.deepEqual(targets('Append to Invoices'), ['Label as processed:0']);
});

test('lookups run once and still continue when they find nothing', () => {
  for (const name of ['Read existing invoices', 'Find month folders']) {
    assert.equal(byName[name].executeOnce, true, name);
    assert.equal(byName[name].alwaysOutputData, true, name);
  }
});

test('Google Sheets writes values as they are, not as formulas', () => {
  for (const name of ['Append to Invoices', 'Append to Review'])
    assert.equal(byName[name].parameters.options.cellFormat, 'RAW', name);
});

test('the Invoices columns are exactly what Prepare rows produces', () => {
  const [row] = runCodeNode(new URL('../src/prepare-rows.js', import.meta.url), {
    input: [{ id: 'x' }],
    nodes: { 'Attach folder': [{ vat_lines: [], line_items: [] }] },
  });
  const columns = byName['Append to Invoices'].parameters.columns;
  assert.deepEqual(Object.keys(columns.value), Object.keys(row));
  assert.deepEqual(
    columns.schema.filter((c) => c.type === 'number').map((c) => c.id),
    ['net_amount', 'vat_amount', 'gross_amount'],
  );
});

// Evaluates an n8n expression string ("=...{{ js }}...") for one item, enough for simple templates.
const render = (expr, json) =>
  expr.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, js) => new Function('$json', `return (${js});`)(json));

test('the Slack message escapes document and email fields', () => {
  const text = render(byName['Post to Slack'].parameters.text, {
    status: 'review',
    file_name: '<!channel>.pdf',
    email_from: 'x@example.com',
    reason: 'supplier name missing; <https://evil.example|pay here> & more',
    gmail_link: 'https://mail.google.com/mail/u/0/#all/19a0f1',
  });
  assert.doesNotMatch(text, /<!channel>|<https:\/\/evil/);
  assert.match(text, /&lt;!channel&gt;\.pdf/);
  assert.match(text, /&amp; more/);
  assert.match(text, /<https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/19a0f1\|Open the email>$/);
});

test('Settings uses a current model and placeholders that are easy to spot', () => {
  assert.match(settings.model, /^claude-/);
  assert.ok(['low', 'medium', 'high'].includes(settings.effort));
  assert.ok(['DMY', 'MDY'].includes(settings.dateOrder));
  assert.match(settings.sheetId, /^YOUR_/);
  assert.match(settings.driveFolderId, /^YOUR_/);
});
