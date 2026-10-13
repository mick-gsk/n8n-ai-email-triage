// Runs of workflow.json in a real n8n instance (npm run check:n8n). The Gmail trigger emits test
// emails with attachments.
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

export const cases = [
  {
    name: 'the invoice PDF becomes one item with its file; the logo is ignored',
    input: [email('19a0f1', 'Ihre Rechnung RE-2026-0042')],
    binary: [
      {
        attachment_0: { data: invoicePdf, mimeType: 'application/pdf', fileName: 'RE-2026-0042.pdf' },
        attachment_1: { data: logo, mimeType: 'image/png', fileName: 'logo.png' },
      },
    ],
    check(run, assert) {
      const items = run.runData['Split attachments'][0].data.main[0];
      assert.equal(items.length, 1);
      assert.equal(items[0].json.file_name, 'RE-2026-0042.pdf');
      assert.equal(items[0].json.status, 'pending');
      assert.equal(items[0].binary.file.mimeType, 'application/pdf');
    },
  },
  {
    name: 'an email without a PDF or image becomes a review item',
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
      const [item] = run.out('Split attachments');
      assert.equal(item.status, 'review');
      assert.deepEqual(item.reasons, ['no PDF or image attachment (found: Rechnung.docx)']);
    },
  },
];
