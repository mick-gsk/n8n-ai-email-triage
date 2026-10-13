// Builds workflow.json from the sources in src/, so the Code node logic, the prompt and the
// output schema live in normal files that can be reviewed and tested.
//
//   node workflows/invoice-extraction/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

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
};

const gmail = credential('gmailOAuth2', 'Gmail account');

// One If condition, in the format of If node version 2.3.
const condition = (id, leftValue, operator, rightValue = '') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
    conditions: [{ id, leftValue, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
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
};

writeWorkflow(
  import.meta.url,
  'workflow.json',
  workflow('Invoice extraction (Gmail + Claude to Sheets and Drive)', nodes, connections),
);
