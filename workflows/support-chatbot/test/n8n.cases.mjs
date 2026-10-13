// Runs of ingest.json in a real n8n instance (npm run check:n8n) against a real Postgres with
// pgvector. Google Drive is replaced by nodes that return fixed files; OpenAI embeddings are
// answered by test/mock-apis.mjs. The cases share the database and run in order.
import { readFileSync } from 'node:fs';

import { embeddingsResponse } from './mock-apis.mjs';

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
