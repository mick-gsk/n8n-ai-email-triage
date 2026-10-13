import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

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

const targets = ({ wf }, name) => wf.connections[name].main.map((branch) => branch.map((c) => c.node));

test('every chunk is stored with file id, file name and source URL', () => {
  const loader = ingest.byName['Document loader'];
  const values = loader.parameters.options.metadata.metadataValues;
  for (const key of ['file_id', 'file_name', 'source_url', 'ingest_run'])
    assert.ok(
      values.some((m) => m.name === key),
      key,
    );
  // A sub-node resolves expressions against the first item, so the metadata must come from the
  // one file the loop is processing.
  for (const m of values.filter((m) => m.name !== 'ingest_run'))
    assert.equal(m.value, `={{ $('Loop over files').item.json.${m.name} }}`, m.name);
  assert.deepEqual(linked(ingest, 'Document loader', 'ai_document'), ['Store chunks']);
  assert.deepEqual(linked(ingest, 'Text splitter', 'ai_textSplitter'), ['Document loader']);
});

test('files are stored one at a time: download, then a loop of store and clean up per file', () => {
  assert.deepEqual(targets(ingest, 'Select files'), [['Download file']]);
  assert.deepEqual(targets(ingest, 'Download file'), [['Loop over files']]);
  const loop = ingest.byName['Loop over files'];
  assert.equal(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.equal(loop.parameters.batchSize, 1);
  assert.deepEqual(targets(ingest, 'Loop over files'), [[], ['Store chunks']], 'done ends the run, loop stores');
  assert.deepEqual(targets(ingest, 'Store chunks'), [['Remove old chunks']]);
  assert.deepEqual(targets(ingest, 'Remove old chunks'), [['Loop over files']]);
});

test('re-ingesting a file removes its older chunks, after the new ones are stored', () => {
  const remove = ingest.byName['Remove old chunks'];
  assert.match(remove.parameters.query, /DELETE FROM support_chunks/);
  assert.match(remove.parameters.query, /WHERE metadata ->> 'file_id' = \$1/);
  // Concurrent runs of the same file: only the newest run's chunks are kept, by every cleanup.
  assert.match(remove.parameters.query, /GREATEST\(\$2::bigint, max\(run\)\)/);
  assert.equal(
    remove.parameters.options.queryReplacement,
    "={{ [ $('Loop over files').item.json.file_id, String($execution.id) ] }}",
  );
  assert.equal(remove.executeOnce, true);
  assert.equal(ingest.byName['Store chunks'].alwaysOutputData, true, 'an emptied file must still lose its old chunks');
});

test('the full sync lists sizes and forgets every chunk when the folder is empty', () => {
  const list = ingest.byName['List folder'];
  assert.deepEqual(list.parameters.options.fields, ['*'], 'Select files needs size, which is not in the field list');
  assert.equal(list.alwaysOutputData, true);
  const forget = ingest.byName['Forget removed files'];
  assert.match(forget.parameters.options.queryReplacement, /\.filter\(Boolean\)/, 'the empty item adds no id');
  assert.equal(forget.executeOnce, true);
});

test('the rate limit counts under a lock, with the session id cleaned like Check message does', () => {
  const count = chat.byName['Count requests'];
  assert.match(count.parameters.query, /^INSERT INTO support_chat_requests[\s\S]*pg_advisory_xact_lock/);
  assert.equal(count.parameters.options.queryBatching, 'transaction', 'the lock is held until the counts are done');
  const expr = count.parameters.options.queryReplacement.slice(4, -3);
  const keyFor = (sessionId) =>
    new Function('$', `return ${expr};`)(() => ({ first: () => ({ json: { sessionId } }) }))[0];
  const settings = JSON.parse(chat.byName.Settings.parameters.jsonOutput);
  for (const sessionId of ['abc', '  abc\u0000 ', 'a\u001bb\t', 's'.repeat(500), undefined]) {
    const [checked] = runCodeNode(new URL('../src/check-message.js', import.meta.url), {
      input: [{ session_recent: 1, all_recent: 1 }],
      nodes: { Settings: [settings], 'Chat Trigger': [{ sessionId, chatInput: 'hi' }] },
    });
    assert.equal(keyFor(sessionId), checked.sessionId, JSON.stringify(sessionId));
  }
  assert.equal(keyFor('  abc\u0000 '), 'abc');
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
