// Runs of workflow.json in a real n8n instance (npm run check:n8n). Gmail, Sheets, Drive and Slack
// are replaced by nodes that record what they would send. The invoices are test suite samples
// from KoSIT (test/fixtures) and copies of them.
import { broken, cii, plainPdf, ubl, zugferdPdf } from './helpers.mjs';

const b64 = (content) => Buffer.from(content).toString('base64');

const email = (id, subject) => ({
  id,
  threadId: id,
  labelIds: ['INBOX', 'Label_ERECHNUNG'],
  from: { value: [{ address: 'rechnung@kornblume-baeckerei.example' }], text: 'rechnung@kornblume-baeckerei.example' },
  subject,
  date: '2026-10-12T08:15:00.000Z',
});
const attach = (...files) => [Object.fromEntries(files.map((f, i) => [`attachment_${i}`, f]))];
const xmlFile = (content, fileName = 'RE-123456XX.xml') => ({
  data: b64(content),
  mimeType: 'application/xml',
  fileName,
});
const pdfFile = (content, fileName = 'RE-123456XX.pdf') => ({
  data: b64(content),
  mimeType: 'application/pdf',
  fileName,
});

const otherRow = {
  row_number: 2,
  seller_name: 'Pixelwerk Agentur GmbH',
  seller_vat_id: 'DE987654321',
  invoice_number: '2026-117',
  iban: 'DE89370400440532013000',
};
const settingsWithoutDrive = {
  maxFileMB: 10,
  processedLabelId: 'Label_ERECHNUNG_DONE',
  reviewLabelId: 'Label_ERECHNUNG_REVIEW',
  sheetId: 'sheet-1',
  driveFolderId: '',
  slackChannel: '#bookkeeping',
};

export const cases = [
  {
    name: 'an XRechnung (UBL) is filed in Drive, added to the sheet and labelled',
    input: [email('19a0f1', 'Rechnung 123456XX')],
    binary: attach(xmlFile(ubl)),
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      assert.equal(run.requests.length, 0, 'no HTTP calls');
      const [upload] = run.out('Upload to Drive');
      assert.equal(upload.sent.name, '2016-04-04 [Seller name] 123456XX.xml');
      assert.equal(upload.sent.folderId, 'YOUR_DRIVE_FOLDER_ID');
      const [row] = run.out('Append to Invoices');
      const v = row.sent.columns.value;
      assert.equal(v.format, 'XRechnung UBL');
      assert.equal(v.invoice_number, '123456XX');
      assert.equal(v.issue_date, '2016-04-04');
      assert.equal(v.seller_vat_id, 'DE123456789');
      assert.equal(v.buyer_reference, '04011000-12345-03');
      assert.equal(v.net_amount, 314.86);
      assert.equal(v.vat_amount, 22.04);
      assert.equal(v.gross_amount, 336.9);
      assert.equal(v.vat_breakdown, 'S 7%: 314.86 + 22.04');
      assert.equal(v.iban, 'DE79000000001234567890');
      assert.equal(JSON.parse(v.line_items).length, 2);
      assert.equal(run.out('Label as processed')[0].sent.messageId, '19a0f1');
      assert.deepEqual(run.out('Label as processed')[0].sent.labelIds, ['Label_ERECHNUNG_DONE']);
      assert.equal(run.ran('Post to Slack'), false);
    },
  },
  {
    name: 'a ZUGFeRD PDF sent with its XML is read from the PDF and stored once',
    input: [email('19a0f2', 'Rechnung 123456XX')],
    binary: attach(pdfFile(zugferdPdf(cii)), xmlFile(cii)),
    stubs: {
      'Read existing invoices': [otherRow],
      'Upload to Drive': [{ id: 'drive-file-1', name: '2016-04-04 [Seller name] 123456XX.pdf' }],
    },
    check(run, assert) {
      const rows = run.out('Append to Invoices');
      assert.equal(rows.length, 1);
      const v = rows[0].sent.columns.value;
      assert.equal(v.format, 'ZUGFeRD PDF (CII)');
      assert.equal(v.file_name, 'RE-123456XX.pdf');
      assert.equal(v.file_link, 'https://drive.google.com/file/d/drive-file-1/view');
      assert.equal(v.gross_amount, 336.9);
      assert.equal(run.ran('Post to Slack'), false);
    },
  },
  {
    name: 'totals that do not add up go to review instead of the sheet',
    input: [email('19a0f3', 'Rechnung 123456XX')],
    binary: attach(xmlFile(broken['wrong gross'](cii))),
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      const [slack] = run.out('Post to Slack');
      assert.match(slack.sent.text, /needs review \(review\): \*RE-123456XX\.xml\*/);
      assert.match(slack.sent.text, /net 314\.86 \+ VAT 22\.04 = 336\.90, but gross is 363\.90/);
      assert.match(slack.sent.text, /<https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/19a0f3\|Open the email>$/);
      const review = run.out('Append to Review')[0].sent.columns.value;
      assert.equal(review.status, 'review');
      assert.equal(review.format, 'XRechnung CII');
      assert.deepEqual(run.out('Label for review')[0].sent.labelIds, ['Label_ERECHNUNG_REVIEW']);
      assert.equal(run.ran('Upload to Drive'), false);
      assert.equal(run.ran('Append to Invoices'), false);
    },
  },
  {
    name: 'an invoice already in the sheet is reported as a duplicate',
    input: [email('19a0f4', 'Rechnung 123456XX')],
    binary: attach(xmlFile(ubl)),
    stubs: {
      'Read existing invoices': [
        otherRow,
        { row_number: 3, seller_vat_id: 'DE123456789', invoice_number: '123456XX', iban: 'DE79000000001234567890' },
      ],
    },
    check(run, assert) {
      const [review] = run.out('Append to Review');
      assert.equal(review.sent.columns.value.status, 'duplicate');
      assert.equal(review.sent.columns.value.reason, 'same seller and invoice number as row 3 of the Invoices sheet');
      assert.equal(run.ran('Append to Invoices'), false);
    },
  },
  {
    name: 'a plain PDF without e-invoice XML goes to review',
    input: [email('19a0f5', 'Ihre Rechnung')],
    binary: attach(pdfFile(plainPdf(), 'Rechnung.pdf')),
    stubs: { 'Read existing invoices': [otherRow] },
    check(run, assert) {
      const [review] = run.out('Append to Review');
      assert.equal(
        review.sent.columns.value.reason,
        'PDF without embedded e-invoice XML (not a ZUGFeRD or Factur-X file)',
      );
      assert.equal(run.out('Post to Slack').length, 1);
    },
  },
  {
    name: 'without a Drive folder the row is written without a file link',
    input: [email('19a0f6', 'Rechnung 123456XX')],
    binary: attach(xmlFile(cii)),
    stubs: { Settings: [settingsWithoutDrive], 'Read existing invoices': [{}] },
    check(run, assert) {
      assert.equal(run.ran('Upload to Drive'), false);
      const [row] = run.out('Append to Invoices');
      assert.equal(row.sent.documentId, 'sheet-1');
      assert.equal(row.sent.columns.value.file_link, '');
      assert.equal(row.sent.columns.value.invoice_number, '123456XX');
      assert.equal(run.out('Label as processed').length, 1);
    },
  },
];
