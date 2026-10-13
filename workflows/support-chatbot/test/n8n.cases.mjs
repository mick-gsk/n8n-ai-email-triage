// Runs of ingest.json and chat.json in a real n8n instance (npm run check:n8n) against a real
// Postgres with pgvector. Google Drive and Slack are replaced by nodes that return fixed files or
// record what they would send; OpenAI embeddings and Claude are answered by test/mock-apis.mjs.
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
    setup: [
      { cmd: psql, input: read('../src/setup.sql') },
      // A session that sent 25 messages five minutes ago, for the rate limit case.
      {
        cmd: psql,
        input:
          "INSERT INTO support_chat_requests (session_id, created_at) SELECT 'flood-session', now() - interval '5 minutes' FROM generate_series(1, 25);",
      },
    ],
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
      assert.equal(run.runData['Remove old chunks'].length, 2, 'one pass of the loop per file');
      assert.equal(run.out('Remove old chunks')[0].removed_chunks, 0);

      const rows = JSON.parse(
        await sql(run, "SELECT json_agg(metadata ORDER BY metadata->>'file_id') FROM support_chunks"),
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].file_id, '1RefundPolicy');
      assert.equal(rows[0].file_name, 'refund-policy.md');
      assert.equal(rows[0].source_url, 'https://drive.google.com/file/d/1RefundPolicy/view');
      assert.ok(rows[0].ingest_run, 'chunks carry the run that stored them');
      assert.equal(rows[1].file_id, '1Shipping', "each file gets its own metadata, not the first file's");
      assert.equal(rows[1].file_name, 'shipping.md');
      assert.equal(rows[1].source_url, 'https://drive.google.com/file/d/1Shipping/view');
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

      assert.deepEqual(run.out('Count requests'), [{ session_recent: 1, all_recent: 1 }]);
      assert.deepEqual(run.out('Reply'), [
        {
          output:
            'Refunds go back to the original payment method within 7 business days after the parcel arrives at our warehouse.' +
            '\n\nSources: [refund-policy.md](https://drive.google.com/file/d/1RefundPolicy/view)',
        },
      ]);
      assert.equal(run.ran('Notify team on Slack'), false);
      const memory = await sql(
        run,
        "SELECT string_agg(message->>'type', ',' ORDER BY id) FROM support_chat_histories WHERE session_id = 'sess-answer'",
      );
      assert.equal(memory, 'human,ai,tool,ai', 'the turn is kept in the chat memory under the session id');
    },
  },
  {
    name: 'chat: a question the documents do not answer goes to the team on Slack',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-handoff', 'Do you offer gift wrapping? <!channel>'),
    http: claudeAnswering('gift wrap', 'unused'),
    check(run, assert) {
      assert.equal(toClaude(run).length, 2);
      const [slack] = run.out('Notify team on Slack');
      assert.equal(slack.sent._node, 'n8n-nodes-base.slack');
      assert.match(slack.sent.text, /needs a person: the documents do not cover this question/);
      assert.match(slack.sent.text, /Session: sess-handoff/);
      assert.match(slack.sent.text, /gift wrapping\? &lt;!channel&gt;/, 'customer text is escaped for Slack');
      assert.match(run.out('Handoff reply')[0].output, /passed your question on to our team/);
      assert.deepEqual(Object.keys(run.out('Handoff reply')[0]), ['output']);
      assert.equal(run.ran('Reply'), false);
    },
  },
  {
    name: 'chat: asking for a person skips the agent',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-human', 'Can I talk to a human please?'),
    http: claudeAnswering('x', 'unused'),
    check(run, assert) {
      assert.equal(toClaude(run).length, 0);
      assert.match(run.out('Notify team on Slack')[0].sent.text, /customer asked for a person/);
      assert.equal(run.out('Handoff reply').length, 1);
    },
  },
  {
    name: 'chat: a failed Claude call becomes a handoff, not an error page',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('sess-error', 'Where do you ship to?'),
    http: {
      ...embeddings,
      'POST api.anthropic.com/v1/messages': () => ({
        status: 400,
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'mock: bad request' } },
      }),
    },
    check(run, assert) {
      assert.ok(toClaude(run).length >= 1);
      assert.match(run.out('Check answer')[0].reason, /^agent error: /);
      assert.equal(run.out('Notify team on Slack').length, 1);
      assert.equal(run.out('Handoff reply').length, 1);
    },
  },
  {
    name: 'chat: a session over the rate limit gets a fixed reply without a model call',
    workflow: 'chat.json',
    trigger: 'Chat Trigger',
    input: chat('flood-session', 'Where do you ship to?'),
    http: claudeAnswering('x', 'unused'),
    check(run, assert) {
      assert.equal(toClaude(run).length, 0);
      assert.equal(run.out('Count requests')[0].session_recent, 26);
      assert.equal(run.out('Check message')[0].reason, 'rate limit');
      assert.match(run.out('Reply')[0].output, /wait a few minutes/);
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
      assert.equal(run.ran('Notify team on Slack'), false);
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
  {
    // List folder outputs one empty item when the folder is empty (alwaysOutputData); the stub
    // stands in for that item.
    name: 'ingest: a sync of an empty folder forgets every chunk',
    workflow: 'ingest.json',
    trigger: 'Nightly sync',
    input: [{}],
    stubs: { 'List folder': [{}] },
    http: embeddings,
    async check(run, assert) {
      assert.deepEqual(run.out('Select files'), []);
      assert.equal(run.ran('Store chunks'), false);
      assert.equal(run.out('Forget removed files')[0].removed_chunks, 1);
      assert.equal(await sql(run, 'SELECT count(*) FROM support_chunks'), '0');
    },
  },
];
