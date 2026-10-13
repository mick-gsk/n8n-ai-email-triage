// Builds workflow.json from the sources in src/, so the Code node logic and the
// prompt live in normal files that can be reviewed and tested.
//
//   node scripts/build-workflow.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Replace these placeholders after import (see README, "Setup").
const settings = {
  model: 'claude-haiku-5-5',
  systemPrompt: read('src/prompt.md').trim(),
  labels: {
    support: 'Label_SUPPORT', sales: 'Label_SALES', billing: 'Label_BILLING',
    partnership: 'Label_PARTNERSHIP', job: 'Label_JOB', newsletter: 'Label_NEWSLETTER',
    spam: 'Label_SPAM', other: 'Label_REVIEW',
  },
  slackChannel: '#inbox-alerts',
  sheetId: 'YOUR_GOOGLE_SHEET_ID',
};

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name, type, typeVersion, position, parameters, ...extra,
});

const nodes = [
  node('Gmail Trigger', 'n8n-nodes-base.gmailTrigger', 1.2, [0, 300], {
    pollTimes: { item: [{ mode: 'everyMinute' }] },
    simple: false,
    filters: { labelIds: ['INBOX'], readStatus: 'unread' },
    options: {},
  }, { credentials: { gmailOAuth2: { id: '', name: 'Gmail account' } } }),

  node('Settings', 'n8n-nodes-base.set', 3.4, [220, 300], {
    mode: 'raw',
    jsonOutput: JSON.stringify(settings, null, 2),
    options: {},
  }, { executeOnce: true }),

  node('Prepare email', 'n8n-nodes-base.code', 2, [440, 300], {
    jsCode: read('src/prepare-email.js'),
  }),

  node('Ask Claude', 'n8n-nodes-base.httpRequest', 4.2, [660, 300], {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request) }}',
    options: { batching: { batch: { batchSize: 5, batchInterval: 1000 } } },
  }, {
    credentials: { httpHeaderAuth: { id: '', name: 'Anthropic API key (x-api-key)' } },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    onError: 'continueRegularOutput',
  }),

  node('Parse AI result', 'n8n-nodes-base.code', 2, [880, 300], {
    jsCode: read('src/parse-result.js'),
  }),

  node('Add Gmail label', 'n8n-nodes-base.gmail', 2.1, [1120, 80], {
    resource: 'message',
    operation: 'addLabels',
    messageId: '={{ $json.id }}',
    labelIds: "={{ [ $('Settings').first().json.labels[$json.category] ] }}",
  }, { credentials: { gmailOAuth2: { id: '', name: 'Gmail account' } } }),

  node('High priority?', 'n8n-nodes-base.if', 2.2, [1120, 260], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'high-priority', leftValue: '={{ $json.priority }}', rightValue: 'high',
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  node('Alert on Slack', 'n8n-nodes-base.slack', 2.2, [1340, 240], {
    resource: 'message',
    operation: 'post',
    select: 'channel',
    channelId: { __rl: true, mode: 'name', value: "={{ $('Settings').first().json.slackChannel }}" },
    text: '=:rotating_light: *{{ $json.category }}* from {{ $json.from }}\n*{{ $json.subject }}*\n{{ $json.summary }}',
    otherOptions: {},
  }, { credentials: { slackApi: { id: '', name: 'Slack account' } } }),

  node('Needs reply?', 'n8n-nodes-base.if', 2.2, [1120, 440], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'needs-reply', leftValue: '={{ $json.needs_reply && !$json.needs_review }}', rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  node('Create reply draft', 'n8n-nodes-base.gmail', 2.1, [1340, 420], {
    resource: 'draft',
    operation: 'create',
    subject: "={{ $json.subject.startsWith('Re:') ? $json.subject : 'Re: ' + $json.subject }}",
    emailType: 'text',
    message: '={{ $json.draft_reply }}',
    options: { threadId: '={{ $json.threadId }}', sendTo: '={{ $json.from }}' },
  }, { credentials: { gmailOAuth2: { id: '', name: 'Gmail account' } } }),

  node('Log to Google Sheets', 'n8n-nodes-base.googleSheets', 4.5, [1120, 620], {
    operation: 'append',
    documentId: { __rl: true, mode: 'id', value: "={{ $('Settings').first().json.sheetId }}" },
    sheetName: { __rl: true, mode: 'name', value: 'Log' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        processedAt: '={{ $json.processedAt }}', from: '={{ $json.from }}', subject: '={{ $json.subject }}',
        category: '={{ $json.category }}', priority: '={{ $json.priority }}', summary: '={{ $json.summary }}',
        needs_reply: '={{ $json.needs_reply }}', needs_review: '={{ $json.needs_review }}', error: '={{ $json.error }}',
      },
      matchingColumns: [],
      schema: ['processedAt', 'from', 'subject', 'category', 'priority', 'summary', 'needs_reply', 'needs_review', 'error']
        .map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true })),
    },
    options: {},
  }, { credentials: { googleSheetsOAuth2Api: { id: '', name: 'Google Sheets account' } } }),
];

const link = (...targets) => ({ main: targets.map((t) => (t ? [t].flat().map((n) => ({ node: n, type: 'main', index: 0 })) : [])) });

const workflow = {
  name: 'AI Email Triage (Gmail + Claude)',
  nodes,
  connections: {
    'Gmail Trigger': link('Settings'),
    Settings: link('Prepare email'),
    'Prepare email': link('Ask Claude'),
    'Ask Claude': link('Parse AI result'),
    'Parse AI result': link(['Add Gmail label', 'High priority?', 'Needs reply?', 'Log to Google Sheets']),
    'High priority?': link('Alert on Slack', null),
    'Needs reply?': link('Create reply draft', null),
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
};

writeFileSync(join(root, 'workflow.json'), JSON.stringify(workflow, null, 2) + '\n');
console.log(`workflow.json: ${nodes.length} nodes`);
