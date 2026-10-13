// Builds workflow.json from the sources in src/, so the Code node logic, the prompt and the
// output schema live in normal files that can be reviewed and tested.
//
//   node workflows/invoice-extraction/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const settings = {
  maxPdfMB: 10,
  minImageKB: 20,
  processedLabelId: 'Label_INVOICE_DONE',
  reviewLabelId: 'Label_INVOICE_REVIEW',
};

const gmail = credential('gmailOAuth2', 'Gmail account');

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
];

const connections = {
  'Gmail Trigger': link('Settings'),
  Settings: link('Split attachments'),
};

writeWorkflow(
  import.meta.url,
  'workflow.json',
  workflow('Invoice extraction (Gmail + Claude to Sheets and Drive)', nodes, connections),
);
