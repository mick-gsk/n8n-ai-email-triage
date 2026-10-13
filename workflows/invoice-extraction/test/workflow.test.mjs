import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
});
