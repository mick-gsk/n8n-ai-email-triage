// Runs of workflow.json in a real n8n instance (npm run check:n8n). The Gmail trigger emits test
// emails with attachments; Claude is answered by a local mock.
import { readFileSync } from 'node:fs';

const extractions = JSON.parse(readFileSync(new URL('./fixtures/extractions.json', import.meta.url), 'utf8'));

const pdf = (text) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`).toString('base64');
const invoicePdf = pdf('RE-2026-0042');
// A signature logo: PNG header, far below minImageKB.
const logo = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

const email = (id, subject) => ({
  id,
  threadId: id,
  labelIds: ['INBOX', 'Label_INVOICES'],
  from: { value: [{ address: 'rechnung@muster-buerobedarf.example' }], text: 'rechnung@muster-buerobedarf.example' },
  subject,
  date: '2026-10-12T08:15:00.000Z',
});

const withInvoice = {
  input: [email('19a0f1', 'Ihre Rechnung RE-2026-0042')],
  binary: [
    {
      attachment_0: { data: invoicePdf, mimeType: 'application/pdf', fileName: 'RE-2026-0042.pdf' },
      attachment_1: { data: logo, mimeType: 'image/png', fileName: 'logo.png' },
    },
  ],
};

const claudeSays = (extraction) => ({
  body: { content: [{ type: 'text', text: JSON.stringify(extraction) }], stop_reason: 'end_turn' },
});

export const cases = [
  {
    name: 'the invoice PDF is sent to Claude as a document and the reply is parsed',
    ...withInvoice,
    http: { 'POST api.anthropic.com/v1/messages': () => claudeSays(extractions.germanInvoice) },
    check(run, assert) {
      const claude = run.requests.filter((r) => r.host === 'api.anthropic.com');
      assert.equal(claude.length, 1, 'the logo is not sent');
      assert.equal(claude[0].headers['x-api-key'], 'test-key');
      const [doc, instruction] = claude[0].body.messages[0].content;
      assert.deepEqual(doc, {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: invoicePdf },
      });
      assert.equal(instruction.type, 'text');
      assert.equal(claude[0].body.output_config.format.type, 'json_schema');

      const [result] = run.out('Collect results');
      assert.equal(result.status, 'ok');
      assert.equal(result.file_name, 'RE-2026-0042.pdf');
      assert.equal(result.invoice_number, 'RE-2026-0042');
      assert.equal(result.message_id, '19a0f1');
    },
  },
  {
    name: 'a failed Claude call ends up in review',
    ...withInvoice,
    http: { 'POST api.anthropic.com/v1/messages': () => ({ status: 500, body: { error: { message: 'overloaded' } } }) },
    check(run, assert) {
      assert.equal(run.requests.length, 4, 'one request and three retries');
      const [result] = run.out('Collect results');
      assert.equal(result.status, 'review');
      assert.match(result.reasons[0], /^API error/);
    },
  },
  {
    name: 'an email without a PDF or image goes to review without calling Claude',
    input: [email('19a0f2', 'Rechnung als Word-Datei')],
    binary: [
      {
        attachment_0: {
          data: Buffer.from('PK').toString('base64'),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileName: 'Rechnung.docx',
        },
      },
    ],
    check(run, assert) {
      assert.equal(run.requests.length, 0);
      assert.equal(run.ran('Ask Claude'), false);
      const [result] = run.out('Collect results');
      assert.deepEqual(result.reasons, ['no PDF or image attachment (found: Rechnung.docx)']);
    },
  },
];
