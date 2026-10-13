import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = JSON.parse(read('../workflow.json'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

test('workflow.json is in sync with src/ (run npm run build)', () => {
  for (const [name, file] of [['Split attachments', 'split-attachments.js']]) {
    assert.equal(byName[name].parameters.jsCode, read(`../src/${file}`), name);
  }
});

test('the trigger downloads attachments and limits emails per poll', () => {
  const { parameters } = byName['Gmail Trigger'];
  assert.equal(parameters.simple, false);
  assert.equal(parameters.options.downloadAttachments, true);
  assert.ok(parameters.maxResults > 0 && parameters.maxResults <= 50);
  assert.match(parameters.filters.q, /has:attachment/);
});
