// Runs of workflow.json in a real n8n instance (npm run check:n8n). The webhook emits the request,
// Claude is answered by a local mock, Respond to Webhook is replaced by a node that records what it
// would send.
import { readFileSync } from 'node:fs';

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
const exported = JSON.parse(workflow.nodes.find((n) => n.name === 'Settings').parameters.jsonOutput);

const secret = 'test-secret-5f0c9a7e21';
// The exported secret is a placeholder the workflow refuses to run with, so cases use their own.
const settings = { ...exported, webhookSecret: secret };

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

export const cases = [
  {
    name: 'hot lead: 202, then Claude qualifies it',
    input: request(hotForm),
    stubs: { Settings: [settings] },
    http: { 'POST api.anthropic.com/v1/messages': () => claudeSays(hot) },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 202);
      assert.deepEqual(response.sent.responseBody, { ok: true });

      const [claude] = run.requests.filter((r) => r.host === 'api.anthropic.com');
      assert.equal(claude.headers['x-api-key'], 'test-key');
      assert.equal(claude.headers['anthropic-version'], '2023-06-01');
      assert.match(claude.body.messages[0].content, /<email>jana\.weber@bakery-weber\.example<\/email>/);
      assert.doesNotMatch(claude.body.messages[0].content, /1234567/, 'the phone number is not sent to Claude');

      const [lead] = run.out('Qualified lead');
      assert.deepEqual(lead.qualification, hot);
      assert.equal(lead.hot, true);
      assert.equal(lead.needs_review, false);
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
    name: 'the exported placeholder secret is refused with 500 and fails the run',
    input: request(hotForm, { 'x-lead-secret': exported.webhookSecret }),
    expectFailure: true,
    check(run, assert) {
      assert.equal(run.out('Respond')[0].sent.options.responseCode, 500);
      assert.equal(run.status, 'error');
      assert.match(run.error.message, /webhookSecret in Settings must be set/);
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
    name: 'spam is set apart',
    input: request({ email: 'seo@rank-fast.example', message: 'We can get you to #1 on Google. Reply for prices.' }),
    stubs: { Settings: [settings] },
    http: {
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
      assert.equal(run.ran('Qualified lead'), false);
    },
  },
  {
    name: 'Claude failing marks the lead for review instead of dropping it',
    input: request(hotForm),
    stubs: { Settings: [settings] },
    http: {
      'POST api.anthropic.com/v1/messages': () => ({ status: 400, body: { error: { message: 'bad request' } } }),
    },
    check(run, assert) {
      const [lead] = run.out('Qualified lead');
      assert.equal(lead.needs_review, true);
      assert.match(lead.error, /API error/);
      assert.equal(lead.qualification.fit_score, null);
      assert.equal(lead.hot, false);
    },
  },
];
