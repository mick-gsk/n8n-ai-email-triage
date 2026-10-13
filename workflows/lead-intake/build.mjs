// Builds workflow.json from the sources in src/, so the Code node logic lives in normal files that
// can be reviewed and tested.
//
//   node workflows/lead-intake/build.mjs   (or npm run build for all workflows)
import { ifCondition, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

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
};

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
  node('Report missing secret', 'n8n-nodes-base.stopAndError', 1, [1320, 460], {
    parameters: { errorMessage: '={{ $json.errors.join("; ") }}' },
  }),

  // Accepted leads end here for now; qualification and the CRM come next.
  node('Lead accepted', 'n8n-nodes-base.noOp', 1, [1100, 280]),
];

const connections = {
  'Lead webhook': link('Settings'),
  Settings: link('Validate lead'),
  'Validate lead': link('Respond'),
  Respond: link('Accepted?'),
  'Accepted?': link('Lead accepted', 'Not configured?'),
  'Not configured?': link('Report missing secret', null),
};

writeWorkflow(import.meta.url, 'workflow.json', workflow('Website lead intake', nodes, connections));
