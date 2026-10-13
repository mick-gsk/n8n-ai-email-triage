// Builds workflow.json from the sources in src/, so the Code node logic lives in normal files that
// can be reviewed and tested.
//
//   node workflows/e-rechnung/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, slackSafe, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const settings = {
  maxFileMB: 10,
  processedLabelId: 'Label_ERECHNUNG_DONE',
  reviewLabelId: 'Label_ERECHNUNG_REVIEW',
  sheetId: 'YOUR_GOOGLE_SHEET_ID',
  // Empty: files are not stored in Drive, rows have no file link.
  driveFolderId: 'YOUR_DRIVE_FOLDER_ID',
  slackChannel: '#bookkeeping',
};

const gmail = credential('gmailOAuth2', 'Gmail account');
const sheets = credential('googleSheetsOAuth2Api', 'Google Sheets account');
const fromSettings = (key) => `={{ $('Settings').first().json.${key} }}`;

const invoiceColumns = [
  'processed_at',
  'format',
  'document_type',
  'type_code',
  'invoice_number',
  'issue_date',
  'due_date',
  'seller_name',
  'seller_vat_id',
  'seller_tax_number',
  'seller_address',
  'buyer_name',
  'buyer_reference',
  'currency',
  'net_amount',
  'vat_amount',
  'gross_amount',
  'payable_amount',
  'vat_breakdown',
  'iban',
  'payment_terms',
  'line_items',
  'file_name',
  'file_link',
  'email_from',
  'email_subject',
  'message_id',
];
const reviewColumns = [
  'processed_at',
  'status',
  'reason',
  'format',
  'seller_name',
  'invoice_number',
  'issue_date',
  'currency',
  'gross_amount',
  'file_name',
  'email_from',
  'email_subject',
  'gmail_link',
  'message_id',
];
const numeric = new Set(['net_amount', 'vat_amount', 'gross_amount', 'payable_amount']);

// One If condition, in the format of If node version 2.3.
const condition = (id, leftValue, operator, rightValue = '') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
    conditions: [{ id, leftValue, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
});

const appendRows = (name, position, tab, columns) =>
  node(name, 'n8n-nodes-base.googleSheets', 4.7, position, {
    parameters: {
      operation: 'append',
      documentId: { __rl: true, mode: 'id', value: fromSettings('sheetId') },
      sheetName: { __rl: true, mode: 'name', value: tab },
      columns: {
        mappingMode: 'defineBelow',
        value: Object.fromEntries(columns.map((c) => [c, `={{ $json.${c} }}`])),
        matchingColumns: [],
        schema: columns.map((id) => ({
          id,
          displayName: id,
          required: false,
          defaultMatch: false,
          display: true,
          type: numeric.has(id) ? 'number' : 'string',
          canBeUsedToMatch: true,
        })),
      },
      // RAW: text from an invoice, such as a seller name "=HYPERLINK(...)", is stored as text
      // instead of being run as a formula. Amounts are sent as numbers and stay numbers.
      options: { cellFormat: 'RAW' },
    },
    credentials: sheets,
  });

const addLabel = (name, position, labelKey) =>
  node(name, 'n8n-nodes-base.gmail', 2.2, position, {
    parameters: {
      resource: 'message',
      operation: 'addLabels',
      messageId: '={{ $json.message_id }}',
      labelIds: `={{ [ $('Settings').first().json.${labelKey} ] }}`,
    },
    credentials: gmail,
  });

const nodes = [
  node('Gmail Trigger', 'n8n-nodes-base.gmailTrigger', 1.4, [0, 300], {
    parameters: {
      pollTimes: { item: [{ mode: 'everyMinute' }] },
      simple: false,
      // Caps memory per run: every attachment of every fetched email is downloaded. Emails beyond
      // the cap are fetched by the next poll.
      maxResults: 10,
      filters: { q: 'label:e-rechnung has:attachment', readStatus: 'both' },
      options: { downloadAttachments: true, dataPropertyAttachmentsPrefixName: 'attachment_' },
    },
    credentials: gmail,
  }),

  node('Settings', 'n8n-nodes-base.set', 3.4, [220, 300], {
    parameters: { mode: 'raw', jsonOutput: JSON.stringify(settings, null, 2), options: {} },
    executeOnce: true,
  }),

  node('Split attachments', 'n8n-nodes-base.code', 2, [440, 300], {
    parameters: { jsCode: read('src/split-attachments.js') },
  }),

  node('XML or PDF?', 'n8n-nodes-base.if', 2.3, [660, 300], {
    parameters: condition('readable', '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'pending'),
  }),

  // Gives the Code node the file content in any binary data mode (in filesystem mode the binary
  // property only holds a reference). The file stays attached for the Drive upload.
  node('Read file', 'n8n-nodes-base.extractFromFile', 1.1, [880, 200], {
    parameters: {
      operation: 'binaryToPropery',
      binaryPropertyName: 'file',
      destinationKey: 'fileBase64',
      options: { keepSource: 'both' },
    },
  }),

  node('Read e-invoice', 'n8n-nodes-base.code', 2, [1100, 200], {
    parameters: { jsCode: read('src/read-einvoice.js') },
  }),

  node('Validate', 'n8n-nodes-base.code', 2, [1320, 200], {
    parameters: { jsCode: read('src/validate-einvoice.js') },
  }),

  node('Collect results', 'n8n-nodes-base.merge', 3.2, [1540, 300], { parameters: {} }),

  node('Read existing invoices', 'n8n-nodes-base.googleSheets', 4.7, [1760, 300], {
    parameters: {
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: fromSettings('sheetId') },
      sheetName: { __rl: true, mode: 'name', value: 'Invoices' },
      options: {},
    },
    credentials: sheets,
    executeOnce: true,
    // An empty sheet returns no rows; without this the run would stop here.
    alwaysOutputData: true,
  }),

  node('Check duplicates', 'n8n-nodes-base.code', 2, [1980, 300], {
    parameters: { jsCode: read('src/check-duplicates.js') },
  }),

  node('Valid?', 'n8n-nodes-base.if', 2.3, [2200, 300], {
    parameters: condition('valid', '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'ok'),
  }),

  node('File in Drive?', 'n8n-nodes-base.if', 2.3, [2420, 100], {
    parameters: condition('drive', fromSettings('driveFolderId'), {
      type: 'string',
      operation: 'notEmpty',
      singleValue: true,
    }),
  }),

  node('Upload to Drive', 'n8n-nodes-base.googleDrive', 3, [2640, 0], {
    parameters: {
      resource: 'file',
      operation: 'upload',
      inputDataFieldName: 'file',
      name: '={{ $json.drive_file_name }}',
      driveId: { __rl: true, mode: 'list', value: 'My Drive' },
      folderId: { __rl: true, mode: 'id', value: fromSettings('driveFolderId') },
      options: {},
    },
    credentials: credential('googleDriveOAuth2Api', 'Google Drive account'),
  }),

  node('Prepare rows', 'n8n-nodes-base.code', 2, [2860, 100], {
    parameters: { jsCode: read('src/prepare-rows.js') },
  }),

  appendRows('Append to Invoices', [3080, 100], 'Invoices', invoiceColumns),
  addLabel('Label as processed', [3300, 100], 'processedLabelId'),

  node('Post to Slack', 'n8n-nodes-base.slack', 2.4, [2420, 460], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: fromSettings('slackChannel') },
      text:
        `=:warning: E-invoice needs review ({{ $json.status }}): *${slackSafe('file_name')}* from ${slackSafe('email_from')}\n` +
        `${slackSafe('reason')}\n` +
        `{{ $json.gmail_link ? '<' + $json.gmail_link + '|Open the email>' : '' }}`,
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: credential('slackApi', 'Slack account'),
  }),

  appendRows('Append to Review', [2420, 640], 'Review', reviewColumns),
  addLabel('Label for review', [2420, 820], 'reviewLabelId'),
];

const connections = {
  'Gmail Trigger': link('Settings'),
  Settings: link('Split attachments'),
  'Split attachments': link('XML or PDF?'),
  // Emails without a usable file skip reading and join the results on input 2.
  'XML or PDF?': {
    main: [[{ node: 'Read file', type: 'main', index: 0 }], [{ node: 'Collect results', type: 'main', index: 1 }]],
  },
  'Read file': link('Read e-invoice'),
  'Read e-invoice': link('Validate'),
  Validate: link('Collect results'),
  'Collect results': link('Read existing invoices'),
  'Read existing invoices': link('Check duplicates'),
  'Check duplicates': link('Valid?'),
  'Valid?': link('File in Drive?', ['Post to Slack', 'Append to Review', 'Label for review']),
  'File in Drive?': link('Upload to Drive', 'Prepare rows'),
  'Upload to Drive': link('Prepare rows'),
  'Prepare rows': link('Append to Invoices'),
  'Append to Invoices': link('Label as processed'),
};

writeWorkflow(
  import.meta.url,
  'workflow.json',
  workflow('E-Rechnung (XRechnung and ZUGFeRD from Gmail to Sheets)', nodes, connections),
);
