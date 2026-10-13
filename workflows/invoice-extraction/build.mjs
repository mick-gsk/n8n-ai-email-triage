// Builds workflow.json from the sources in src/, so the Code node logic, the prompt and the
// output schema live in normal files that can be reviewed and tested.
//
//   node workflows/invoice-extraction/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, slackSafe, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const settings = {
  model: 'claude-sonnet-5-5',
  effort: 'low',
  systemPrompt: read('src/prompt.md').trim(),
  outputSchema: JSON.parse(read('src/schema.json')),
  dateOrder: 'DMY',
  maxPdfMB: 10,
  minImageKB: 20,
  processedLabelId: 'Label_INVOICE_DONE',
  reviewLabelId: 'Label_INVOICE_REVIEW',
  sheetId: 'YOUR_GOOGLE_SHEET_ID',
  driveFolderId: 'YOUR_DRIVE_FOLDER_ID',
  slackChannel: '#bookkeeping',
};

const gmail = credential('gmailOAuth2', 'Gmail account');
const sheets = credential('googleSheetsOAuth2Api', 'Google Sheets account');
const drive = credential('googleDriveOAuth2Api', 'Google Drive account');
const fromSettings = (key) => `={{ $('Settings').first().json.${key} }}`;

const invoiceColumns = [
  'processed_at',
  'document_type',
  'supplier_name',
  'supplier_vat_id',
  'invoice_number',
  'invoice_date',
  'due_date',
  'currency',
  'net_amount',
  'vat_amount',
  'gross_amount',
  'vat_rates',
  'iban',
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
  'document_type',
  'supplier_name',
  'invoice_number',
  'invoice_date',
  'currency',
  'gross_amount',
  'file_name',
  'email_from',
  'email_subject',
  'gmail_link',
  'message_id',
];
const numeric = new Set(['net_amount', 'vat_amount', 'gross_amount']);

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
      // RAW: text from a document, such as a supplier name "=HYPERLINK(...)", is stored as text
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
      filters: { q: 'label:invoices has:attachment', readStatus: 'both' },
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

  node('Readable file?', 'n8n-nodes-base.if', 2.3, [660, 300], {
    parameters: condition('readable', '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'pending'),
  }),

  node('Read file', 'n8n-nodes-base.extractFromFile', 1.1, [880, 200], {
    parameters: {
      operation: 'binaryToPropery',
      binaryPropertyName: 'file',
      destinationKey: 'fileBase64',
      options: { keepSource: 'both' },
    },
  }),

  node('Build request', 'n8n-nodes-base.code', 2, [1100, 200], {
    parameters: { jsCode: read('src/build-request.js') },
  }),

  node('Ask Claude', 'n8n-nodes-base.httpRequest', 4.4, [1320, 200], {
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.request) }}',
      // A document makes a large request (every PDF page is sent as text and as an image), so
      // they go out two at a time.
      options: { batching: { batch: { batchSize: 2, batchInterval: 2000 } }, timeout: 180000 },
    },
    credentials: credential('httpHeaderAuth', 'Anthropic API key (x-api-key)'),
    // n8n retries a node that continues on error only when its first output item is an error,
    // and then re-runs the whole batch. Fixed waits only; 5 tries and 5 s are n8n's maximums.
    // Whatever still fails reaches Validate as { error } and goes to review.
    retryOnFail: true,
    maxTries: 4,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput',
  }),

  node('Validate', 'n8n-nodes-base.code', 2, [1540, 200], {
    parameters: { jsCode: read('src/validate-invoice.js') },
  }),

  node('Collect results', 'n8n-nodes-base.merge', 3.2, [1760, 300], { parameters: {} }),

  node('Read existing invoices', 'n8n-nodes-base.googleSheets', 4.7, [1980, 300], {
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

  node('Check duplicates', 'n8n-nodes-base.code', 2, [2200, 300], {
    parameters: { jsCode: read('src/check-duplicates.js') },
  }),

  node('Valid?', 'n8n-nodes-base.if', 2.3, [2420, 300], {
    parameters: condition('valid', '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'ok'),
  }),

  node('Find month folders', 'n8n-nodes-base.googleDrive', 3, [2640, 100], {
    parameters: {
      resource: 'fileFolder',
      operation: 'search',
      searchMethod: 'query',
      queryString: '',
      returnAll: true,
      filter: {
        folderId: { __rl: true, mode: 'id', value: fromSettings('driveFolderId') },
        whatToSearch: 'folders',
      },
      options: {},
    },
    credentials: drive,
    executeOnce: true,
    alwaysOutputData: true,
  }),

  node('Plan folders', 'n8n-nodes-base.code', 2, [2860, 100], {
    parameters: { jsCode: read('src/plan-folders.js') },
  }),

  node('Folder missing?', 'n8n-nodes-base.if', 2.3, [3080, 100], {
    parameters: condition('missing', '={{ $json.folder_id }}', {
      type: 'string',
      operation: 'empty',
      singleValue: true,
    }),
  }),

  node('Create month folder', 'n8n-nodes-base.googleDrive', 3, [3300, 0], {
    parameters: {
      resource: 'folder',
      operation: 'create',
      name: '={{ $json.month }}',
      driveId: { __rl: true, mode: 'list', value: 'My Drive' },
      folderId: { __rl: true, mode: 'id', value: fromSettings('driveFolderId') },
      options: {},
    },
    credentials: drive,
  }),

  node('Merge folders', 'n8n-nodes-base.merge', 3.2, [3520, 100], { parameters: {} }),

  node('Attach folder', 'n8n-nodes-base.code', 2, [3740, 100], {
    parameters: { jsCode: read('src/attach-folder.js') },
  }),

  node('Upload to Drive', 'n8n-nodes-base.googleDrive', 3, [3960, 100], {
    parameters: {
      resource: 'file',
      operation: 'upload',
      inputDataFieldName: 'file',
      name: '={{ $json.drive_file_name }}',
      driveId: { __rl: true, mode: 'list', value: 'My Drive' },
      folderId: { __rl: true, mode: 'id', value: '={{ $json.folder_id }}' },
      options: {},
    },
    credentials: drive,
  }),

  node('Prepare rows', 'n8n-nodes-base.code', 2, [4180, 100], {
    parameters: { jsCode: read('src/prepare-rows.js') },
  }),

  appendRows('Append to Invoices', [4400, 100], 'Invoices', invoiceColumns),
  addLabel('Label as processed', [4620, 100], 'processedLabelId'),

  node('Post to Slack', 'n8n-nodes-base.slack', 2.4, [2640, 460], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: fromSettings('slackChannel') },
      text:
        `=:warning: Invoice needs review ({{ $json.status }}): *${slackSafe('file_name')}* from ${slackSafe('email_from')}\n` +
        `${slackSafe('reason')}\n` +
        `{{ $json.gmail_link ? '<' + $json.gmail_link + '|Open the email>' : '' }}`,
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: credential('slackApi', 'Slack account'),
  }),

  appendRows('Append to Review', [2640, 640], 'Review', reviewColumns),
  addLabel('Label for review', [2640, 820], 'reviewLabelId'),
];

const connections = {
  'Gmail Trigger': link('Settings'),
  Settings: link('Split attachments'),
  'Split attachments': link('Readable file?'),
  // Files that cannot be read automatically skip Claude and join the results on input 2.
  'Readable file?': {
    main: [[{ node: 'Read file', type: 'main', index: 0 }], [{ node: 'Collect results', type: 'main', index: 1 }]],
  },
  'Read file': link('Build request'),
  'Build request': link('Ask Claude'),
  'Ask Claude': link('Validate'),
  Validate: link('Collect results'),
  'Collect results': link('Read existing invoices'),
  'Read existing invoices': link('Check duplicates'),
  'Check duplicates': link('Valid?'),
  'Valid?': link('Find month folders', ['Post to Slack', 'Append to Review', 'Label for review']),
  'Find month folders': link('Plan folders'),
  'Plan folders': link('Folder missing?'),
  'Folder missing?': {
    main: [
      [{ node: 'Create month folder', type: 'main', index: 0 }],
      [{ node: 'Merge folders', type: 'main', index: 1 }],
    ],
  },
  'Create month folder': link('Merge folders'),
  'Merge folders': link('Attach folder'),
  'Attach folder': link('Upload to Drive'),
  'Upload to Drive': link('Prepare rows'),
  'Prepare rows': link('Append to Invoices'),
  'Append to Invoices': link('Label as processed'),
};

writeWorkflow(
  import.meta.url,
  'workflow.json',
  workflow('Invoice extraction (Gmail + Claude to Sheets and Drive)', nodes, connections),
);
