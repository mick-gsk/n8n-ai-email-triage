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
  assert.deepEqual(next('Accepted?', 1), ['Not configured?']);
  assert.deepEqual(next('Not configured?', 0), ['Report missing secret']);
});

test('the exported secret is a placeholder the workflow refuses', () => {
  assert.match(settings.webhookSecret, /^REPLACE/);
  assert.equal(settings.secretQueryParam, '', 'secrets in URLs end up in logs, so this is opt-in');
  assert.ok(settings.fields.email.length && settings.fields.message.length);
  assert.ok(!settings.fields.email.includes(settings.honeypotField));
});
