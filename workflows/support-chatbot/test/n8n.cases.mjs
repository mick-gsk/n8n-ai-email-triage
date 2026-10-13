// Runs of ingest.json and chat.json in a real n8n instance (npm run check:n8n) against a real
// Postgres with pgvector. Google Drive is replaced by nodes that return fixed files; OpenAI
// embeddings and Claude are answered by test/mock-apis.mjs.
// The cases share the database and run in order: the chat cases search the chunks stored by the
// ingest cases.
import { readFileSync } from 'node:fs';

import { embeddingsResponse, lastToolResult, text, toolUse } from './mock-apis.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const psql = ['psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'];
const sql = async (run, query) => (await run.services.db([...psql, '-tA', '-c', query])).trim();

export const services = {
  db: {
    image: 'pgvector/pgvector:pg17',
    env: { POSTGRES_PASSWORD: 'check' },
    port: 5432,
    ready: ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
    setup: [{ cmd: psql, input: read('../src/setup.sql') }],
    credentials: ({ host, port }) => ({
      postgres: { host, port, database: 'postgres', user: 'postgres', password: 'check', ssl: 'disable' },
    }),
  },
};

const file = (id, name, mimeType = 'text/markdown') => ({
  id,
  name,
  mimeType,
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
  trashed: false,
});
const downloaded = (f, content) => ({
  ...f,
  $binary: { data: { data: Buffer.from(content).toString('base64'), mimeType: f.mimeType, fileName: f.name } },
});

const refunds = file('1RefundPolicy', 'refund-policy.md');
const shipping = file('1Shipping', 'shipping.md');
const refundPolicy = read('fixtures/refund-policy.md');
const refundPolicyV2 = refundPolicy.replace('within 5 business days', 'within 7 business days');

const embeddings = { 'POST api.openai.com/v1/embeddings': embeddingsResponse };

// Claude searches with the customer's words, then answers from what the search returned, or
// hands off when the returned passages do not contain `needle`.
const claudeAnswering = (needle, answer) => ({
  ...embeddings,
  'POST api.anthropic.com/v1/messages': (req) => {
    const result = lastToolResult(req);
    if (result === null) return toolUse('search_documents', { input: req.body.messages.at(-1).content });
    return result.includes(needle) ? text(answer) : text('HANDOFF: the documents do not cover this question');
  },
});

const chat = (sessionId, chatInput) => [{ sessionId, action: 'sendMessage', chatInput }];
const toClaude = (run) => run.requests.filter((r) => r.host === 'api.anthropic.com');

export const cases = [
  {
    name: 'ingest: new files are split, embedded and stored with their file metadata',
    workflow: 'ingest.json',
    trigger: 'Drive Trigger',
    input: [refunds, shipping, file('1Photo', 'team.jpg', 'image/jpeg'), { ...file('1Old', 'old.md'), trashed: true }],
    stubs: {
      'Download file': [downloaded(refunds, refundPolicy), downloaded(shipping, read('fixtures/shipping.md'))],
    },
    http: embeddings,
    async check(run, assert) {
      assert.deepEqual(
        run.out('Select files').map((f) => f.file_id),
        ['1RefundPolicy', '1Shipping'],
        'images and trashed files are skipped',
      );
      const [embedRequest] = run.requests.filter((r) => r.path === '/v1/embeddings');
      assert.equal(embedRequest.body.model, 'text-embedding-3-small');
      assert.equal(run.out('Remove old chunks')[0].removed_chunks, 0);

      const rows = JSON.parse(
        await sql(run, "SELECT json_agg(metadata ORDER BY metadata->>'file_id') FROM support_chunks"),
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].file_id, '1RefundPolicy');
      assert.equal(rows[0].file_name, 'refund-policy.md');
      assert.equal(rows[0].source_url, 'https://drive.google.com/file/d/1RefundPolicy/view');
      assert.ok(rows[0].ingest_run, 'chunks carry the run that stored them');
      assert.equal(await sql(run, 'SELECT vector_dims(embedding) FROM support_chunks LIMIT 1'), '1536');
    },
  },
  {
    name: 'ingest: a changed file replaces its old chunks instead of adding to them',
    workflow: 'ingest.json',
    trigger: 'Drive Trigger',
    input: [refunds],
    stubs: { 'Download file': [downloaded(refunds, refundPolicyV2)] },
    http: embeddings,
    async check(run, assert) {
      assert.equal(run.out('Remove old chunks')[0].removed_chunks, 1);
      const texts = await sql(run, "SELECT text FROM support_chunks WHERE metadata->>'file_id' = '1RefundPolicy'");
      assert.match(texts, /within 7 business days/);
      assert.doesNotMatch(texts, /within 5 business days/);
      assert.equal(await sql(run, 'SELECT count(*) FROM support_chunks'), '2', 'the other file is untouched');
    },
  },
  {
    name: 'chat: a question is answered from the stored chunks, with the source linked',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-answer', 'How long does a refund take?'),
    http: claudeAnswering(
      'within 7 business days',
      'Refunds go back to the original payment method within 7 business days after the parcel arrives at our warehouse.\nSources: refund-policy.md',
    ),
    async check(run, assert) {
      const claude = toClaude(run);
      assert.equal(claude.length, 2, 'one search, one answer');
      assert.equal(claude[0].body.model, 'claude-haiku-5-5');
      assert.equal(claude[0].headers['x-api-key'], 'test-key');
      assert.match(claude[0].body.system, /HANDOFF:/);
      assert.equal(claude[0].body.tools[0].name, 'search_documents');
      assert.match(lastToolResult(claude[1]), /refund-policy\.md/);

      assert.deepEqual(run.out('Reply'), [
        {
          output:
            'Refunds go back to the original payment method within 7 business days after the parcel arrives at our warehouse.' +
            '\n\nSources: [refund-policy.md](https://drive.google.com/file/d/1RefundPolicy/view)',
        },
      ]);
      const memory = await sql(
        run,
        "SELECT string_agg(message->>'type', ',' ORDER BY id) FROM support_chat_histories WHERE session_id = 'sess-answer'",
      );
      assert.equal(memory, 'human,ai,tool,ai', 'the turn is kept in the chat memory under the session id');
    },
  },
  {
    name: 'chat: a question the documents do not answer gets the contact address, not a guess',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-handoff', 'Do you offer gift wrapping?'),
    http: claudeAnswering('gift wrap', 'unused'),
    check(run, assert) {
      assert.equal(toClaude(run).length, 2);
      assert.equal(run.out('Check answer')[0].route, 'handoff');
      assert.deepEqual(run.out('Reply'), [
        {
          output: 'I could not find an answer to that in our documentation. Please contact us at support@example.com.',
        },
      ]);
    },
  },
  {
    name: 'chat: over-long messages get a fixed reply without a model call',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-long', 'x'.repeat(1001)),
    http: claudeAnswering('x', 'unused'),
    check(run, assert) {
      assert.equal(toClaude(run).length, 0);
      assert.match(run.out('Reply')[0].output, /too long/);
    },
  },
  {
    name: 'ingest: the nightly sync forgets files that were removed from the folder',
    workflow: 'ingest.json',
    trigger: 'Nightly sync',
    input: [{}],
    stubs: {
      'List folder': [refunds],
      'Download file': [downloaded(refunds, refundPolicyV2)],
    },
    http: embeddings,
    async check(run, assert) {
      assert.equal(run.out('Forget removed files')[0].removed_chunks, 1);
      assert.equal(await sql(run, "SELECT count(*) FROM support_chunks WHERE metadata->>'file_id' = '1Shipping'"), '0');
      assert.equal(
        await sql(run, "SELECT count(*) FROM support_chunks WHERE metadata->>'file_id' = '1RefundPolicy'"),
        '1',
      );
    },
  },
];
