// Runs of workflow.json in a real n8n instance (npm run check:n8n). The webhook emits the request,
// HubSpot and Claude are answered by a local mock, Respond to Webhook and Slack are replaced by
// nodes that record what they would send.
import { readFileSync } from 'node:fs';

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
const exported = JSON.parse(workflow.nodes.find((n) => n.name === 'Settings').parameters.jsonOutput);

const secret = 'test-secret-5f0c9a7e21';
// The exported secret and business description are placeholders the workflow refuses to run with,
// so cases use their own.
const settings = {
  ...exported,
  webhookSecret: secret,
  businessDescription: 'Web design agency for small businesses. Websites and shops from 5,000 to 30,000 EUR.',
  hubspot: { ...exported.hubspot, contactUrl: 'https://app.hubspot.com/contacts/123/record/0-1/' },
};

const request = (body, headers = { 'x-lead-secret': secret }) => [
  {
    headers: { 'content-type': 'application/json', ...headers },
    params: {},
    query: {},
    body,
    webhookUrl: 'https://n8n.example.com/webhook/lead',
    executionMode: 'production',
  },
];

const hotForm = {
  name: 'Jana Weber',
  email: 'Jana.Weber@Bakery-Weber.example',
  company: 'Bäckerei Weber',
  phone: '+49 30 1234567',
  message: 'We need a new website with online pre-orders for our 3 shops. Budget around 12,000 EUR, live by March.',
};

const claudeSays = (result) => ({ body: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
const hot = {
  fit_score: 86,
  intent: 'buy',
  budget: 'around 12,000 EUR',
  timeline: 'by March',
  summary: 'Bakery with 3 shops wants a website with online pre-orders.',
  next_step: 'Call within a day and send a quote.',
};

const noContact = { body: { total: 0, results: [] } };
const upserted = (id, isNew) => () => ({
  body: { status: 'COMPLETE', results: [{ id, new: isNew, properties: {} }] },
});
const noteCreated = { body: { id: '9001' } };

const hubspot = (requests, path) => requests.filter((r) => r.host === 'api.hubapi.com' && r.path === path);

export const cases = [
  {
    name: 'hot lead from a new contact: 202, contact created as MQL, note, Slack alert',
    input: request(hotForm),
    stubs: { Settings: [settings] },
    http: {
      'POST api.hubapi.com/crm/v3/objects/contacts/search': () => noContact,
      'POST api.anthropic.com/v1/messages': () => claudeSays(hot),
      'POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert': upserted('101', true),
      'POST api.hubapi.com/crm/v3/objects/notes': () => noteCreated,
    },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 202);
      assert.deepEqual(response.sent.responseBody, { ok: true });

      const [search] = hubspot(run.requests, '/crm/v3/objects/contacts/search');
      assert.equal(search.headers.authorization, 'Bearer test-token');
      assert.equal(search.body.filterGroups[0].filters[0].value, 'jana.weber@bakery-weber.example');

      const [claude] = run.requests.filter((r) => r.host === 'api.anthropic.com');
      assert.equal(claude.headers['x-api-key'], 'test-key');
      assert.match(claude.body.messages[0].content, /<crm>New contact/);
      assert.doesNotMatch(claude.body.messages[0].content, /1234567/, 'the phone number is not sent to Claude');

      const [upsert] = hubspot(run.requests, '/crm/v3/objects/contacts/batch/upsert');
      const [input] = upsert.body.inputs;
      assert.equal(input.idProperty, 'email');
      assert.equal(input.id, 'jana.weber@bakery-weber.example');
      assert.deepEqual(input.properties, {
        email: 'jana.weber@bakery-weber.example',
        firstname: 'Jana',
        lastname: 'Weber',
        company: 'Bäckerei Weber',
        phone: '+49 30 1234567',
        ai_lead_score: '86',
        ai_lead_intent: 'buy',
        lifecyclestage: 'marketingqualifiedlead',
      });

      const [note] = hubspot(run.requests, '/crm/v3/objects/notes');
      assert.equal(note.body.associations[0].to.id, '101');
      assert.match(note.body.properties.hs_note_body, /fit 86\/100, intent buy/);

      const [alert] = run.out('Alert on Slack');
      assert.equal(alert.sent.channelId, '#sales-leads');
      assert.match(alert.sent.text, /^:fire: \*Hot lead\* \(fit 86\/100\): Jana Weber, Bäckerei Weber/);
      assert.match(alert.sent.text, /<https:\/\/app\.hubspot\.com\/contacts\/123\/record\/0-1\/101\|Open in HubSpot>$/);
    },
  },
  {
    name: 'existing customer is updated without moving the lifecycle stage back, no alert',
    input: request({
      email: 'tom@shop.example',
      first_name: 'Tom',
      message: 'Could you also quote a newsletter integration at some point?',
    }),
    stubs: { Settings: [settings] },
    http: {
      'POST api.hubapi.com/crm/v3/objects/contacts/search': () => ({
        body: {
          total: 1,
          results: [{ id: '55', properties: { email: 'tom@shop.example', lifecyclestage: 'customer' } }],
        },
      }),
      'POST api.anthropic.com/v1/messages': () =>
        claudeSays({
          fit_score: 55,
          intent: 'info',
          budget: '',
          timeline: '',
          summary: 'Existing customer asks about a newsletter integration.',
          next_step: 'Reply with options and ask about scope.',
        }),
      'POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert': upserted('55', false),
      'POST api.hubapi.com/crm/v3/objects/notes': () => noteCreated,
    },
    check(run, assert) {
      const [claude] = run.requests.filter((r) => r.host === 'api.anthropic.com');
      assert.match(claude.body.messages[0].content, /<crm>Existing contact\. Lifecycle stage: customer\.<\/crm>/);
      const [upsert] = hubspot(run.requests, '/crm/v3/objects/contacts/batch/upsert');
      assert.deepEqual(upsert.body.inputs[0].properties, {
        email: 'tom@shop.example',
        firstname: 'Tom',
        ai_lead_score: '55',
        ai_lead_intent: 'info',
      });
      assert.equal(hubspot(run.requests, '/crm/v3/objects/notes')[0].body.associations[0].to.id, '55');
      assert.equal(run.out('Alert on Slack').length, 0);
    },
  },
  {
    name: 'a filled honeypot gets 202 but goes no further',
    input: request({ ...hotForm, fax: 'x' }),
    stubs: { Settings: [settings] },
    check(run, assert) {
      assert.equal(run.out('Respond')[0].sent.options.responseCode, 202);
      assert.equal(run.out('Accepted?').length, 0);
      assert.equal(run.requests.length, 0);
    },
  },
  {
    name: 'wrong secret gets 401 and nothing else runs',
    input: request(hotForm, { 'x-lead-secret': 'guess' }),
    stubs: { Settings: [settings] },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 401);
      assert.equal(run.requests.length, 0);
      assert.equal(run.out('Accepted?').length, 0);
    },
  },
  {
    name: 'the exported placeholder settings are refused with 500 and fail the run',
    input: request(hotForm, { 'x-lead-secret': exported.webhookSecret }),
    expectFailure: true,
    check(run, assert) {
      assert.equal(run.out('Respond')[0].sent.options.responseCode, 500);
      assert.equal(run.status, 'error');
      assert.match(run.error.message, /webhookSecret in Settings must be set/);
      assert.match(run.error.message, /businessDescription in Settings must describe the business/);
      assert.equal(run.requests.length, 0);
    },
  },
  {
    name: 'invalid form gets 400 with the list of errors',
    input: request({ email: 'not-an-email', message: '' }),
    stubs: { Settings: [settings] },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 400);
      assert.deepEqual(response.sent.responseBody.errors, ['message is required', 'email is not a valid address']);
      assert.equal(run.requests.length, 0);
    },
  },
  {
    name: 'spam is not written to HubSpot',
    input: request({ email: 'seo@rank-fast.example', message: 'We can get you to #1 on Google. Reply for prices.' }),
    stubs: { Settings: [settings] },
    http: {
      'POST api.hubapi.com/crm/v3/objects/contacts/search': () => noContact,
      'POST api.anthropic.com/v1/messages': () =>
        claudeSays({
          fit_score: 10,
          intent: 'spam',
          budget: '',
          timeline: '',
          summary: 'SEO service offer.',
          next_step: 'Ignore.',
        }),
    },
    check(run, assert) {
      assert.equal(run.out('Skip spam').length, 1);
      assert.equal(run.out('Skip spam')[0].qualification.fit_score, 0);
      assert.equal(hubspot(run.requests, '/crm/v3/objects/contacts/batch/upsert').length, 0);
      assert.equal(run.ran('Build contact'), false);
    },
  },
  {
    name: 'Claude failing still saves the lead and asks for review on Slack',
    input: request(hotForm),
    stubs: { Settings: [settings] },
    http: {
      'POST api.hubapi.com/crm/v3/objects/contacts/search': () => noContact,
      'POST api.anthropic.com/v1/messages': () => ({ status: 400, body: { error: { message: 'bad request' } } }),
      'POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert': upserted('102', true),
      'POST api.hubapi.com/crm/v3/objects/notes': () => noteCreated,
    },
    check(run, assert) {
      const [parsed] = run.out('Parse qualification');
      assert.equal(parsed.needs_review, true);
      assert.match(parsed.error, /API error/);
      const [upsert] = hubspot(run.requests, '/crm/v3/objects/contacts/batch/upsert');
      assert.equal(upsert.body.inputs[0].properties.lifecyclestage, 'lead');
      assert.equal(upsert.body.inputs[0].properties.ai_lead_score, undefined);
      assert.match(run.out('Alert on Slack')[0].sent.text, /^:warning: \*Lead needs review\*/);
    },
  },
  {
    name: 'HubSpot rejecting the contact fails the run after retries',
    input: request(hotForm),
    stubs: { Settings: [settings] },
    expectFailure: true,
    http: {
      'POST api.hubapi.com/crm/v3/objects/contacts/search': () => noContact,
      'POST api.anthropic.com/v1/messages': () => claudeSays(hot),
      'POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert': () => ({
        status: 400,
        body: { status: 'error', message: 'Property "ai_lead_score" does not exist' },
      }),
    },
    check(run, assert) {
      assert.equal(run.status, 'error');
      assert.equal(hubspot(run.requests, '/crm/v3/objects/contacts/batch/upsert').length, 3);
      assert.equal(run.error.node?.name ?? run.error.node, 'Upsert contact');
      assert.equal(run.ran('Add note'), false);
      assert.equal(run.ran('Alert on Slack'), false);
    },
  },
];
