import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const load = (file) => {
  const wf = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  return { wf, byName: Object.fromEntries(wf.nodes.map((n) => [n.name, n])) };
};
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const ingest = load('ingest.json');

// Names of the nodes connected to `name` through connections of `type`, in either direction.
const linked = ({ wf }, name, type) =>
  Object.entries(wf.connections).flatMap(([from, outputs]) =>
    (outputs[type] ?? []).flat().flatMap(({ node }) => (from === name ? [node] : node === name ? [from] : [])),
  );

test('ingest.json is in sync with src/ (run npm run build)', () => {
  assert.equal(ingest.byName['Select files'].parameters.jsCode, src('select-files.js'));
});

test('every chunk is stored with file id, file name and source URL', () => {
  const loader = ingest.byName['Document loader'];
  const names = loader.parameters.options.metadata.metadataValues.map((m) => m.name);
  for (const key of ['file_id', 'file_name', 'source_url', 'ingest_run']) assert.ok(names.includes(key), key);
  assert.deepEqual(linked(ingest, 'Document loader', 'ai_document'), ['Store chunks']);
  assert.deepEqual(linked(ingest, 'Text splitter', 'ai_textSplitter'), ['Document loader']);
});

test('re-ingesting a file removes its older chunks, after the new ones are stored', () => {
  assert.deepEqual(ingest.wf.connections['Store chunks'].main, [
    [{ node: 'Remove old chunks', type: 'main', index: 0 }],
  ]);
  const remove = ingest.byName['Remove old chunks'];
  assert.match(remove.parameters.query, /DELETE FROM support_chunks/);
  assert.match(remove.parameters.query, /metadata ->> 'file_id' IN/);
  assert.match(remove.parameters.query, /metadata ->> 'ingest_run' IS DISTINCT FROM \$2/);
  assert.match(remove.parameters.options.queryReplacement, /\$execution\.id/);
  assert.equal(remove.executeOnce, true);
  assert.equal(ingest.byName['Store chunks'].alwaysOutputData, true, 'an emptied file must still lose its old chunks');
});

test('the table and embedding dimension match setup.sql', () => {
  const store = ingest.byName['Store chunks'].parameters;
  assert.match(src('setup.sql'), new RegExp(`CREATE TABLE IF NOT EXISTS ${store.tableName} \\(`));
  assert.match(src('setup.sql'), /embedding vector\(1536\)/, 'text-embedding-3-small has 1536 dimensions');
  assert.equal(ingest.byName.Embeddings.parameters.model, 'text-embedding-3-small');
});

test('SQL gets outside values only as query parameters', () => {
  for (const n of Object.values(ingest.byName).filter((n) => n.type === 'n8n-nodes-base.postgres')) {
    assert.doesNotMatch(n.parameters.query, /\{\{/, n.name);
    assert.match(n.parameters.options.queryReplacement, /^=\{\{ \[/, `${n.name}: parameters as an array`);
  }
});
