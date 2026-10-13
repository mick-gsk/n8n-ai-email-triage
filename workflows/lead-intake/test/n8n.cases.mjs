// Runs of workflow.json in a real n8n instance (npm run check:n8n). The webhook emits the request,
// Respond to Webhook is replaced by a node that records what it would send.
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

const form = {
  name: 'Jana Weber',
  email: 'Jana.Weber@Bakery-Weber.example',
  company: 'Bäckerei Weber',
  message: 'We need a new website with online pre-orders for our 3 shops.',
};

export const cases = [
  {
    name: 'valid form gets 202 and a clean lead',
    input: request(form),
    stubs: { Settings: [settings] },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 202);
      assert.deepEqual(response.sent.responseBody, { ok: true });
      const [accepted] = run.out('Lead accepted');
      assert.equal(accepted.lead.email, 'jana.weber@bakery-weber.example');
      assert.equal(accepted.lead.firstName, 'Jana');
    },
  },
  {
    name: 'a filled honeypot gets 202 but goes no further',
    input: request({ ...form, fax: 'x' }),
    stubs: { Settings: [settings] },
    check(run, assert) {
      assert.equal(run.out('Respond')[0].sent.options.responseCode, 202);
      assert.equal(run.out('Accepted?').length, 0);
      assert.equal(run.ran('Report missing secret'), false);
    },
  },
  {
    name: 'wrong secret gets 401 and nothing else runs',
    input: request(form, { 'x-lead-secret': 'guess' }),
    stubs: { Settings: [settings] },
    check(run, assert) {
      const [response] = run.out('Respond');
      assert.equal(response.sent.options.responseCode, 401);
      assert.equal(run.out('Accepted?').length, 0);
    },
  },
  {
    name: 'the exported placeholder secret is refused with 500 and fails the run',
    input: request(form, { 'x-lead-secret': exported.webhookSecret }),
    expectFailure: true,
    check(run, assert) {
      assert.equal(run.out('Respond')[0].sent.options.responseCode, 500);
      assert.equal(run.status, 'error');
      assert.match(run.error.message, /webhookSecret in Settings must be set/);
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
    },
  },
];
