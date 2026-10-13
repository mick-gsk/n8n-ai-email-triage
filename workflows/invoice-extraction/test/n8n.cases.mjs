// Runs of workflow.json in a real n8n instance (npm run check:n8n). Gmail, Sheets, Drive and Slack
// are replaced by nodes that record what they would send; Claude is answered by a local mock.
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

const otherRow = {
  row_number: 2,
  supplier_name: 'Example Hosting Ltd',
  supplier_vat_id: 'GB123456789',
  invoice_number: 'INV 10016',
  invoice_date: '2026-09-05',
  gross_amount: 1440,
  iban: 'GB82WEST12345698765432',
};
const septemberFolder = { id: 'folder-2026-09', name: '2026-09' };

export const cases = [
  {
    name: 'a clean invoice is uploaded to Drive, added to the sheet and labelled',
    ...withInvoice,
    http: { 'POST api.anthropic.com/v1/messages': () => claudeSays(extractions.germanInvoice) },
    stubs: {
      'Read existing invoices': [otherRow],
      'Find month folders': [septemberFolder],
      'Create month folder': [{ id: 'folder-2026-10', name: '2026-10' }],
    },
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

      assert.deepEqual(
        run.out('Create month folder').map((f) => f.id),
        ['folder-2026-10'],
      );
      const [upload] = run.out('Upload to Drive');
      assert.equal(upload.sent.folderId, 'folder-2026-10');
      assert.equal(upload.sent.name, '2026-10-02 Muster Bürobedarf GmbH RE-2026-0042.pdf');

      const [row] = run.out('Append to Invoices');
      const v = row.sent.columns.value;
      assert.equal(v.supplier_vat_id, 'DE123456788');
      assert.equal(v.invoice_date, '2026-10-02');
      assert.equal(v.due_date, '2026-10-16');
      assert.equal(v.net_amount, 1250);
      assert.equal(v.vat_amount, 237.5);
      assert.equal(v.gross_amount, 1487.5);
      assert.equal(v.iban, 'DE89370400440532013000');
      assert.deepEqual(run.out('Label as processed')[0].sent.labelIds, ['Label_INVOICE_DONE']);
      assert.equal(run.out('Label as processed')[0].sent.messageId, '19a0f1');
      assert.equal(run.ran('Post to Slack'), false);
    },
  },
  {
    name: 'totals that do not add up go to review instead of the sheet',
    ...withInvoice,
    http: {
      'POST api.anthropic.com/v1/messages': () =>
        claudeSays({ ...extractions.germanInvoice, gross_amount: '1.478,50' }),
    },
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      const [slack] = run.out('Post to Slack');
      assert.match(slack.sent.text, /needs review \(review\): \*RE-2026-0042\.pdf\*/);
      assert.match(slack.sent.text, /net 1250\.00 \+ VAT 237\.50 = 1487\.50, but gross is 1478\.50/);
      assert.match(slack.sent.text, /<https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/19a0f1\|Open the email>$/);
      assert.equal(run.out('Append to Review')[0].sent.columns.value.status, 'review');
      assert.deepEqual(run.out('Label for review')[0].sent.labelIds, ['Label_INVOICE_REVIEW']);
      assert.equal(run.ran('Upload to Drive'), false);
      assert.equal(run.ran('Append to Invoices'), false);
    },
  },
  {
    name: 'an invoice already in the sheet is reported as a duplicate',
    ...withInvoice,
    http: { 'POST api.anthropic.com/v1/messages': () => claudeSays(extractions.germanInvoice) },
    stubs: {
      'Read existing invoices': [
        otherRow,
        {
          row_number: 3,
          supplier_name: 'Muster Bürobedarf GmbH',
          supplier_vat_id: 'DE123456788',
          invoice_number: 'RE-2026-0042',
          invoice_date: '2026-10-02',
          gross_amount: 1487.5,
          iban: 'DE89370400440532013000',
        },
      ],
    },
    check(run, assert) {
      const [review] = run.out('Append to Review');
      assert.equal(review.sent.columns.value.status, 'duplicate');
      assert.match(review.sent.columns.value.reason, /same supplier and invoice number as row 3/);
      assert.equal(run.out('Post to Slack').length, 1);
      assert.equal(run.ran('Append to Invoices'), false);
    },
  },
  {
    name: 'a failed Claude call ends up in review',
    ...withInvoice,
    http: { 'POST api.anthropic.com/v1/messages': () => ({ status: 500, body: { error: { message: 'overloaded' } } }) },
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      assert.equal(run.requests.length, 4, 'one request and three retries');
      const [review] = run.out('Append to Review');
      assert.match(review.sent.columns.value.reason, /^API error/);
      assert.equal(run.out('Label for review').length, 1);
      assert.equal(run.ran('Append to Invoices'), false);
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
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      assert.equal(run.requests.length, 0);
      assert.equal(run.ran('Ask Claude'), false);
      const [review] = run.out('Append to Review');
      assert.equal(review.sent.columns.value.reason, 'no PDF or image attachment (found: Rechnung.docx)');
      assert.equal(run.out('Post to Slack').length, 1);
    },
  },
];
