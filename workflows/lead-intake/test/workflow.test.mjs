import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const settings = JSON.parse(byName.Settings.parameters.jsonOutput);
const next = (name, output = 0) => (workflow.connections[name]?.main[output] ?? []).map((c) => c.node);

test('workflow.json is in sync with src/ (run npm run build)', () => {
  // Code node "Validate lead" lives in src/validate-lead.js, and so on.
  for (const n of workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    const file = `${n.name.toLowerCase().replace(/[^a-z]+/g, '-')}.js`;
    assert.equal(n.parameters.jsCode, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), n.name);
  }
  assert.equal(settings.systemPrompt, readFileSync(new URL('../src/prompt.md', import.meta.url), 'utf8').trim());
});

test('the webhook answers through Respond, right after validation', () => {
  const hook = byName['Lead webhook'].parameters;
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.responseMode, 'responseNode');
  assert.equal(byName['Lead webhook'].parameters.authentication, undefined, 'the secret is checked in Validate lead');
  assert.deepEqual(next('Lead webhook'), ['Settings']);
  assert.deepEqual(next('Settings'), ['Validate lead']);
  assert.deepEqual(next('Validate lead'), ['Respond']);
  assert.equal(byName.Respond.parameters.options.responseCode, '={{ $json.response.status }}');
  assert.equal(byName.Respond.parameters.responseBody, '={{ $json.response.body }}');
  assert.deepEqual(next('Respond'), ['Accepted?']);
  assert.deepEqual(next('Accepted?', 0), ['Find contact']);
  assert.deepEqual(next('Accepted?', 1), ['Not configured?']);
  assert.deepEqual(next('Not configured?', 0), ['Report missing secret']);
});

test('the exported secret is a placeholder the workflow refuses', () => {
  assert.match(settings.webhookSecret, /^REPLACE/);
  assert.equal(settings.secretQueryParam, '', 'secrets in URLs end up in logs, so this is opt-in');
  assert.ok(settings.fields.email.length && settings.fields.message.length);
  assert.ok(!settings.fields.email.includes(settings.honeypotField));
});

test('Ask Claude retries, times out and hands failures on instead of stopping', () => {
  const ask = byName['Ask Claude'];
  assert.equal(ask.retryOnFail, true);
  assert.ok(ask.maxTries >= 3 && ask.maxTries <= 5, 'n8n allows 2 to 5 tries');
  assert.ok(ask.waitBetweenTries > 0 && ask.waitBetweenTries <= 5000, 'n8n caps the wait at 5000 ms');
  assert.equal(ask.onError, 'continueRegularOutput', 'a failed call must still save the lead for review');
  assert.ok(ask.parameters.options.timeout > 0);
  assert.equal(ask.credentials.httpHeaderAuth.id, '');
});

test('HubSpot calls retry, time out, and stop the run when they still fail', () => {
  for (const name of ['Find contact', 'Upsert contact', 'Add note']) {
    const n = byName[name];
    assert.match(n.parameters.url, /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\//, name);
    assert.equal(n.parameters.nodeCredentialType, 'hubspotAppToken', name);
    assert.equal(n.retryOnFail, true, name);
    assert.ok(n.waitBetweenTries > 0 && n.waitBetweenTries <= 5000, name);
    assert.ok(n.parameters.options.timeout > 0, name);
    assert.equal(n.onError, undefined, `${name} must fail the run so the error workflow reports it`);
  }
  assert.match(byName['Upsert contact'].parameters.url, /\/contacts\/batch\/upsert$/);
});

test('spam goes nowhere near HubSpot or Slack', () => {
  assert.deepEqual(next('Parse qualification'), ['Spam?']);
  assert.deepEqual(next('Spam?', 0), ['Skip spam']);
  assert.deepEqual(next('Skip spam'), []);
  assert.deepEqual(next('Spam?', 1), ['Build contact']);
  assert.match(byName['Spam?'].parameters.conditions.conditions[0].leftValue, /!\$json\.needs_review/);
});

test('Slack only posts the escaped text built in Build note', () => {
  assert.deepEqual(next('Add note'), ['Alert?']);
  assert.deepEqual(next('Alert?', 0), ['Alert on Slack']);
  assert.equal(byName['Alert on Slack'].parameters.text, "={{ $('Build note').item.json.slackText }}");
  assert.equal(byName['Alert on Slack'].parameters.otherOptions.includeLinkToWorkflow, false);
});

test('hot score threshold and HubSpot property names are configured', () => {
  assert.ok(Number.isInteger(settings.hotScore) && settings.hotScore > 0 && settings.hotScore <= 100);
  assert.ok(settings.hubspot.scoreProperty && settings.hubspot.intentProperty);
  const stages = readFileSync(new URL('../src/build-contact.js', import.meta.url), 'utf8');
  assert.match(stages, new RegExp(`'${settings.hubspot.hotLifecycleStage}'`));
});
