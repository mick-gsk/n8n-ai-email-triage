import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runCodeNode } from './run-code-node.mjs';

const workflow = JSON.parse(readFileSync(new URL('../error-workflow.json', import.meta.url), 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

// Shape of the Error Trigger output, taken from the node's own example data.
const nodeFailed = {
  execution: {
    id: 231,
    url: 'https://n8n.example.com/workflow/7/executions/231',
    error: { message: 'Label_SUPPORT is not a valid label', node: { name: 'Add Gmail label' } },
    lastNodeExecuted: 'Add Gmail label',
    mode: 'trigger',
  },
  workflow: { id: '7', name: 'AI Email Triage (Gmail + Claude)' },
};

const format = (items) => runCodeNode('format-error-alert.js', { input: items });

test('error workflow: Error Trigger -> Format alert -> Post to Slack', () => {
  assert.equal(byName['Error Trigger'].type, 'n8n-nodes-base.errorTrigger');
  assert.deepEqual(workflow.connections['Error Trigger'].main, [[{ node: 'Format alert', type: 'main', index: 0 }]]);
  assert.deepEqual(workflow.connections['Format alert'].main, [[{ node: 'Post to Slack', type: 'main', index: 0 }]]);
  assert.equal(byName['Post to Slack'].parameters.text, '={{ $json.text }}');
});

test('error workflow: in sync with src/ and no credentials stored', () => {
  assert.equal(
    byName['Format alert'].parameters.jsCode,
    readFileSync(new URL('../src/format-error-alert.js', import.meta.url), 'utf8'),
  );
  for (const n of workflow.nodes) for (const c of Object.values(n.credentials ?? {})) assert.equal(c.id, '');
});

test('format alert: names workflow, failed node and message, links the execution', () => {
  const [{ text, executionId }] = format([nodeFailed]);
  assert.equal(
    text,
    [
      ':x: *AI Email Triage (Gmail + Claude)* failed in *Add Gmail label*',
      'Label_SUPPORT is not a valid label',
      '<https://n8n.example.com/workflow/7/executions/231|Open execution>',
    ].join('\n'),
  );
  assert.equal(executionId, '231');
});

test('format alert: trigger failures have no execution', () => {
  const [{ text }] = format([
    { trigger: { error: { message: 'invalid_grant' }, mode: 'trigger' }, workflow: { id: '7', name: 'Triage' } },
  ]);
  assert.match(text, /failed in \*trigger\*\ninvalid_grant$/);
});

test('format alert: error text from an email cannot ping the channel', () => {
  const failed = structuredClone(nodeFailed);
  failed.execution.error.message = 'Subject "<!channel> pay now" too long';
  const [{ text }] = format([failed]);
  assert.doesNotMatch(text, /<!channel>/);
  assert.match(text, /&lt;!channel&gt;/);
});

test('format alert: long messages are cut', () => {
  const failed = structuredClone(nodeFailed);
  failed.execution.error.message = 'x'.repeat(5000);
  const [{ text }] = format([failed]);
  assert.ok(text.length < 700);
});
