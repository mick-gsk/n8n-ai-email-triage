import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const load = (file) => {
  const wf = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  return { wf, byName: Object.fromEntries(wf.nodes.map((n) => [n.name, n])) };
};
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const ingest = load('ingest.json');
const chat = load('chat.json');

// Names of the nodes connected to `name` through connections of `type`, in either direction.
const linked = ({ wf }, name, type) =>
  Object.entries(wf.connections).flatMap(([from, outputs]) =>
    (outputs[type] ?? []).flat().flatMap(({ node }) => (from === name ? [node] : node === name ? [from] : [])),
  );

test('exports are in sync with src/ (run npm run build)', () => {
  assert.equal(ingest.byName['Select files'].parameters.jsCode, src('select-files.js'));
  assert.equal(chat.byName['Check message'].parameters.jsCode, src('check-message.js'));
  assert.equal(chat.byName['Check answer'].parameters.jsCode, src('check-answer.js'));
  assert.equal(chat.byName['Support agent'].parameters.options.systemMessage, src('system-prompt.md').trim());
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

test('ingest and chat use the same table and embedding model, and the table matches setup.sql', () => {
  const store = ingest.byName['Store chunks'].parameters;
  const search = chat.byName.search_documents.parameters;
  assert.equal(store.tableName, search.tableName);
  assert.match(src('setup.sql'), new RegExp(`CREATE TABLE IF NOT EXISTS ${store.tableName} \\(`));
  assert.match(src('setup.sql'), /embedding vector\(1536\)/, 'text-embedding-3-small has 1536 dimensions');
  assert.equal(ingest.byName.Embeddings.parameters.model, 'text-embedding-3-small');
  assert.equal(chat.byName['Query embeddings'].parameters.model, ingest.byName.Embeddings.parameters.model);
});

test('SQL gets outside values only as query parameters', () => {
  for (const { byName } of [ingest, chat])
    for (const n of Object.values(byName).filter((n) => n.type === 'n8n-nodes-base.postgres')) {
      assert.doesNotMatch(n.parameters.query, /\{\{/, n.name);
      assert.match(n.parameters.options.queryReplacement, /^=\{\{ \[/, `${n.name}: parameters as an array`);
    }
});

test('the chat is public for the website, limited to its origin, and answers from the last node', () => {
  const { parameters } = chat.byName['Chat Trigger'];
  assert.equal(parameters.public, true);
  assert.equal(parameters.mode, 'webhook');
  assert.notEqual(parameters.options.allowedOrigins, '*');
  assert.equal(parameters.options.responseMode, 'lastNode');
});

test('the agent has Claude, the document search and a memory keyed by the session id', () => {
  assert.deepEqual(linked(chat, 'Claude', 'ai_languageModel'), ['Support agent']);
  assert.deepEqual(linked(chat, 'search_documents', 'ai_tool'), ['Support agent']);
  assert.deepEqual(linked(chat, 'Chat memory', 'ai_memory'), ['Support agent']);
  const memory = chat.byName['Chat memory'].parameters;
  assert.equal(memory.sessionIdType, 'customKey');
  assert.equal(memory.sessionKey, '={{ $json.sessionId }}');
  assert.equal(chat.byName.search_documents.parameters.mode, 'retrieve-as-tool');
  assert.equal(chat.byName.search_documents.parameters.includeDocumentMetadata, true, 'Check answer needs file_name');
  assert.match(src('system-prompt.md'), /`search_documents`/, 'the prompt names the tool as n8n exposes it');
});

test('the agent returns its tool calls, retries, and hands failures to Check answer', () => {
  const agent = chat.byName['Support agent'];
  assert.equal(agent.parameters.options.returnIntermediateSteps, true, 'Check answer reads the search results');
  assert.equal(agent.parameters.text, '={{ $json.prompt }}');
  assert.equal(agent.retryOnFail, true);
  assert.equal(agent.onError, 'continueErrorOutput');
  assert.deepEqual(
    chat.wf.connections['Support agent'].main.map((branch) => branch.map((c) => c.node)),
    [['Check answer'], ['Check answer']],
  );
  assert.equal(chat.byName.Claude.parameters.model.value, 'claude-haiku-5-5');
});

test('only the reply text goes back to the browser', () => {
  for (const name of ['Reply', 'Handoff reply']) {
    const { parameters } = chat.byName[name];
    assert.equal(parameters.mode, 'manual');
    assert.deepEqual(
      parameters.assignments.assignments.map((a) => a.name),
      ['output'],
      name,
    );
    assert.notEqual(parameters.includeOtherFields, true, name);
  }
});

// Evaluates an n8n expression string ("=...{{ js }}...") for one item, enough for simple templates.
const render = (expr, json) =>
  expr.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, js) => new Function('$json', `return (${js});`)(json));

test('the Slack handoff escapes customer text so it cannot ping the channel or add links', () => {
  const textExpr = chat.byName['Notify team on Slack'].parameters.text;
  const text = render(textExpr, {
    reason: 'customer asked for a person',
    sessionId: 'abc',
    question: '<!channel> refund <https://evil.example|here> & now',
  });
  assert.doesNotMatch(text, /<!channel>|<https:/);
  assert.match(text, /&lt;!channel&gt; refund/);
  assert.match(text, /&amp; now/);
});
