// Builds workflow.json from the sources in src/, so the Code node logic and the prompt live in
// normal files that can be reviewed and tested.
//
//   node workflows/lead-intake/build.mjs   (or npm run build for all workflows)
import { credential, ifCondition, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const settings = {
  webhookSecret: 'REPLACE_WITH_A_LONG_RANDOM_STRING',
  secretHeader: 'x-lead-secret',
  secretQueryParam: '',
  honeypotField: 'fax',
  fields: {
    email: ['email', 'e-mail', 'email_address'],
    name: ['name', 'full_name', 'your-name'],
    firstName: ['first_name', 'firstname', 'first-name'],
    lastName: ['last_name', 'lastname', 'last-name'],
    company: ['company', 'company_name', 'organization'],
    phone: ['phone', 'phone_number', 'tel'],
    website: ['website', 'url', 'company_website'],
    message: ['message', 'comments', 'your-message', 'details'],
  },
  requiredFields: ['email', 'message'],
  model: 'claude-haiku-5-5',
  systemPrompt: read('src/prompt.md').trim(),
  businessDescription:
    'REPLACE: what the business sells, to whom, typical project size, and what it does not do. ' +
    'Example: Web design agency for small businesses in Germany. Websites and online shops, ' +
    'typical projects from 5,000 to 30,000 EUR. No app development, no one-off logo work.',
  hotScore: 70,
  hubspot: {
    scoreProperty: 'ai_lead_score',
    intentProperty: 'ai_lead_intent',
    hotLifecycleStage: 'marketingqualifiedlead',
    contactUrl: 'https://app.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-1/',
  },
  slackChannel: '#sales-leads',
};

const hubspotAuth = {
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'hubspotAppToken',
};
const hubspotCredential = credential('hubspotAppToken', 'HubSpot private app token');

// HubSpot answers 429 when the account's rate limit is hit and the search endpoint has a lower
// limit than the rest, so failed calls are retried. A call that still fails stops the run: the
// error workflow reports it, and the lead is in the execution data to re-run from.
const hubspotRetry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };

const hubspotPost = (name, position, path, jsonBody) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.5, position, {
    parameters: {
      method: 'POST',
      url: `https://api.hubapi.com${path}`,
      ...hubspotAuth,
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout: 20000 },
    },
    credentials: hubspotCredential,
    ...hubspotRetry,
  });

const searchBody = `={{ JSON.stringify({
  filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: $json.lead.email }] }],
  properties: ['email', 'firstname', 'lastname', 'company', 'lifecyclestage'],
  limit: 1
}) }}`;

const nodes = [
  node('Lead webhook', 'n8n-nodes-base.webhook', 2.2, [0, 300], {
    parameters: { httpMethod: 'POST', path: 'lead', responseMode: 'responseNode', options: {} },
    webhookId: 'f6e541c0-317c-4171-8e23-f6e6e3c39f31',
  }),

  node('Settings', 'n8n-nodes-base.set', 3.4, [220, 300], {
    parameters: { mode: 'raw', jsonOutput: JSON.stringify(settings, null, 2), options: {} },
    executeOnce: true,
  }),

  node('Validate lead', 'n8n-nodes-base.code', 2, [440, 300], {
    parameters: { jsCode: read('src/validate-lead.js') },
  }),

  node('Respond', 'n8n-nodes-base.respondToWebhook', 1.5, [660, 300], {
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response.body }}',
      options: { responseCode: '={{ $json.response.status }}' },
    },
  }),

  node('Accepted?', 'n8n-nodes-base.if', 2.2, [880, 300], {
    parameters: ifCondition('accepted', '={{ $json.status }}', 'accepted', { type: 'string', operation: 'equals' }),
  }),

  node('Not configured?', 'n8n-nodes-base.if', 2.2, [1100, 480], {
    parameters: ifCondition('misconfigured', '={{ $json.status }}', 'misconfigured', {
      type: 'string',
      operation: 'equals',
    }),
  }),

  // The form already got a 500. This makes the run fail as well, so the error workflow reports it.
  node('Report missing settings', 'n8n-nodes-base.stopAndError', 1, [1320, 460], {
    parameters: { errorMessage: '={{ $json.errors.join("; ") }}' },
  }),

  hubspotPost('Find contact', [1100, 280], '/crm/v3/objects/contacts/search', searchBody),

  node('Prepare qualification', 'n8n-nodes-base.code', 2, [1320, 280], {
    parameters: { jsCode: read('src/prepare-qualification.js') },
  }),

  node('Ask Claude', 'n8n-nodes-base.httpRequest', 4.5, [1540, 280], {
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
      options: { timeout: 60000 },
    },
    credentials: credential('httpHeaderAuth', 'Anthropic API key (x-api-key)'),
    // Whatever still fails after the retries reaches Parse qualification as { error }, and the
    // lead is saved for review instead of being lost.
    retryOnFail: true,
    maxTries: 4,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput',
  }),

  node('Parse qualification', 'n8n-nodes-base.code', 2, [1760, 280], {
    parameters: { jsCode: read('src/parse-qualification.js') },
  }),

  node('Spam?', 'n8n-nodes-base.if', 2.2, [1980, 280], {
    parameters: ifCondition('spam', "={{ $json.qualification.intent === 'spam' && !$json.needs_review }}", '', {
      type: 'boolean',
      operation: 'true',
      singleValue: true,
    }),
  }),

  node('Skip spam', 'n8n-nodes-base.noOp', 1, [2200, 120]),

  node('Build contact', 'n8n-nodes-base.code', 2, [2200, 320], {
    parameters: { jsCode: read('src/build-contact.js') },
  }),

  hubspotPost(
    'Upsert contact',
    [2420, 320],
    '/crm/v3/objects/contacts/batch/upsert',
    '={{ JSON.stringify($json.upsert) }}',
  ),

  node('Build note', 'n8n-nodes-base.code', 2, [2640, 320], {
    parameters: { jsCode: read('src/build-note.js') },
  }),

  hubspotPost('Add note', [2860, 320], '/crm/v3/objects/notes', '={{ JSON.stringify($json.note) }}'),

  node('Alert?', 'n8n-nodes-base.if', 2.2, [3080, 320], {
    parameters: ifCondition('alert', "={{ $('Build note').item.json.alert }}", '', {
      type: 'string',
      operation: 'notEmpty',
      singleValue: true,
    }),
  }),

  node('Alert on Slack', 'n8n-nodes-base.slack', 2.7, [3300, 300], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: "={{ $('Settings').first().json.slackChannel }}" },
      text: "={{ $('Build note').item.json.slackText }}",
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: credential('slackApi', 'Slack account'),
  }),
];

const connections = {
  'Lead webhook': link('Settings'),
  Settings: link('Validate lead'),
  'Validate lead': link('Respond'),
  Respond: link('Accepted?'),
  'Accepted?': link('Find contact', 'Not configured?'),
  'Not configured?': link('Report missing settings', null),
  'Find contact': link('Prepare qualification'),
  'Prepare qualification': link('Ask Claude'),
  'Ask Claude': link('Parse qualification'),
  'Parse qualification': link('Spam?'),
  'Spam?': link('Skip spam', 'Build contact'),
  'Build contact': link('Upsert contact'),
  'Upsert contact': link('Build note'),
  'Build note': link('Add note'),
  'Add note': link('Alert?'),
  'Alert?': link('Alert on Slack', null),
};

writeWorkflow(import.meta.url, 'workflow.json', workflow('Website lead intake (HubSpot + Claude)', nodes, connections));
