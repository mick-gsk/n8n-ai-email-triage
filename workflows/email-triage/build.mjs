// Builds workflow.json from the sources in src/, so the Code node logic and the prompt live in
// normal files that can be reviewed and tested.
//
//   node workflows/email-triage/build.mjs   (or npm run build for all workflows)
import { credential, ifCondition, link, node, reader, slackSafe, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

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

const gmail = credential('gmailOAuth2', 'Gmail account');
const slack = credential('slackApi', 'Slack account');

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
    credentials: credential('httpHeaderAuth', 'Anthropic API key (x-api-key)'),
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
    credentials: credential('googleSheetsOAuth2Api', 'Google Sheets account'),
  }),
];

const connections = {
  'Gmail Trigger': link('Settings'),
  Settings: link('Prepare email'),
  'Prepare email': link('Ask Claude'),
  'Ask Claude': link('Parse AI result'),
  'Parse AI result': link(['Add Gmail label', 'High priority?', 'Needs reply?', 'Log to Google Sheets']),
  'High priority?': link('Alert on Slack', null),
  'Needs reply?': link('Create reply draft', null),
};

writeWorkflow(import.meta.url, 'workflow.json', workflow('AI Email Triage (Gmail + Claude)', nodes, connections));
