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
    support: 'Label_SUPPORT',
    sales: 'Label_SALES',
    billing: 'Label_BILLING',
    partnership: 'Label_PARTNERSHIP',
    job: 'Label_JOB',
    newsletter: 'Label_NEWSLETTER',
    spam: 'Label_SPAM',
    other: 'Label_REVIEW',
  },
  slackChannel: '#inbox-alerts',
  sheetId: 'YOUR_GOOGLE_SHEET_ID',
};

const gmail = { gmailOAuth2: { id: '', name: 'Gmail account' } };
const slack = { slackApi: { id: '', name: 'Slack account' } };

// node('Name', 'type', typeVersion, [x, y], { parameters, ...other node fields })
const node = (name, type, typeVersion, position, { parameters = {}, ...extra } = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

const ifCondition = (id, leftValue, rightValue, operator) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
});

// Sender, subject and summary come from outside. Slack treats <!channel>, <!here> and <url|text>
// in message text as mentions and links, so &, < and > are escaped as its docs require.
const slackSafe = (field) =>
  `{{ String($json.${field}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}`;

const logColumns = [
  'processedAt',
  'from',
  'subject',
  'category',
  'priority',
  'summary',
  'needs_reply',
  'needs_review',
  'error',
];

const nodes = [
  node('Gmail Trigger', 'n8n-nodes-base.gmailTrigger', 1.2, [0, 300], {
    parameters: {
      pollTimes: { item: [{ mode: 'everyMinute' }] },
      simple: false,
      filters: { labelIds: ['INBOX'], readStatus: 'unread' },
      options: {},
    },
    credentials: gmail,
  }),

  node('Settings', 'n8n-nodes-base.set', 3.4, [220, 300], {
    parameters: { mode: 'raw', jsonOutput: JSON.stringify(settings, null, 2), options: {} },
    executeOnce: true,
  }),

  node('Prepare email', 'n8n-nodes-base.code', 2, [440, 300], {
    parameters: { jsCode: read('src/prepare-email.js') },
  }),

  node('Ask Claude', 'n8n-nodes-base.httpRequest', 4.2, [660, 300], {
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
      options: { batching: { batch: { batchSize: 5, batchInterval: 1000 } }, timeout: 60000 },
    },
    credentials: { httpHeaderAuth: { id: '', name: 'Anthropic API key (x-api-key)' } },
    // n8n retries a node that continues on error only when its first output item is an error,
    // and then re-runs the whole batch. Fixed waits only; 5 tries and 5 s are n8n's maximums.
    // Whatever still fails reaches Parse AI result as { error } and is labelled for review.
    retryOnFail: true,
    maxTries: 4,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput',
  }),

  node('Parse AI result', 'n8n-nodes-base.code', 2, [880, 300], {
    parameters: { jsCode: read('src/parse-result.js') },
  }),

  node('Add Gmail label', 'n8n-nodes-base.gmail', 2.1, [1120, 80], {
    parameters: {
      resource: 'message',
      operation: 'addLabels',
      messageId: '={{ $json.id }}',
      labelIds: "={{ [ $('Settings').first().json.labels[$json.category] ] }}",
    },
    credentials: gmail,
  }),

  node('High priority?', 'n8n-nodes-base.if', 2.2, [1120, 260], {
    parameters: ifCondition('high-priority', '={{ $json.priority }}', 'high', { type: 'string', operation: 'equals' }),
  }),

  node('Alert on Slack', 'n8n-nodes-base.slack', 2.2, [1340, 240], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: "={{ $('Settings').first().json.slackChannel }}" },
      text: `=:rotating_light: *{{ $json.category }}* from ${slackSafe('from')}\n*${slackSafe('subject')}*\n${slackSafe('summary')}`,
      otherOptions: {},
    },
    credentials: slack,
  }),

  node('Needs reply?', 'n8n-nodes-base.if', 2.2, [1120, 440], {
    parameters: ifCondition('needs-reply', '={{ $json.needs_reply && !$json.needs_review }}', '', {
      type: 'boolean',
      operation: 'true',
      singleValue: true,
    }),
  }),

  node('Create reply draft', 'n8n-nodes-base.gmail', 2.1, [1340, 420], {
    parameters: {
      resource: 'draft',
      operation: 'create',
      subject: "={{ $json.subject.startsWith('Re:') ? $json.subject : 'Re: ' + $json.subject }}",
      emailType: 'text',
      message: '={{ $json.draft_reply }}',
      options: { threadId: '={{ $json.threadId }}', sendTo: '={{ $json.from }}' },
    },
    credentials: gmail,
  }),

  node('Log to Google Sheets', 'n8n-nodes-base.googleSheets', 4.5, [1120, 620], {
    parameters: {
      operation: 'append',
      documentId: { __rl: true, mode: 'id', value: "={{ $('Settings').first().json.sheetId }}" },
      sheetName: { __rl: true, mode: 'name', value: 'Log' },
      columns: {
        mappingMode: 'defineBelow',
        value: Object.fromEntries(logColumns.map((c) => [c, `={{ $json.${c} }}`])),
        matchingColumns: [],
        schema: logColumns.map((id) => ({
          id,
          displayName: id,
          required: false,
          defaultMatch: false,
          display: true,
          type: 'string',
          canBeUsedToMatch: true,
        })),
      },
      // RAW: a subject like =IMPORTXML(...) is stored as text instead of being run as a formula.
      options: { cellFormat: 'RAW' },
    },
    credentials: { googleSheetsOAuth2Api: { id: '', name: 'Google Sheets account' } },
  }),
];

// link('A', null, ['B', 'C']): output 0 goes to A, output 1 nowhere, output 2 to B and C.
const link = (...outputs) => ({
  main: outputs.map((t) => (t ? [t].flat().map((n) => ({ node: n, type: 'main', index: 0 })) : [])),
});

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
