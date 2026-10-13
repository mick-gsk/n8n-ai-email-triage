import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

test('workflow.json is in sync with src/ (run npm run build)', () => {
  for (const [name, file] of [['Prepare email', 'prepare-email.js'], ['Parse AI result', 'parse-result.js']]) {
    assert.equal(byName[name].parameters.jsCode, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
  }
  const settings = JSON.parse(byName.Settings.parameters.jsonOutput);
  assert.equal(settings.systemPrompt, readFileSync(new URL('../src/prompt.md', import.meta.url), 'utf8').trim());
});

test('every connection points to an existing node', () => {
  for (const [from, { main }] of Object.entries(workflow.connections)) {
    assert.ok(byName[from], `unknown source ${from}`);
    for (const branch of main) for (const { node } of branch) assert.ok(byName[node], `${from} -> unknown ${node}`);
  }
});

test('every node except the trigger is reachable from the trigger', () => {
  const seen = new Set(['Gmail Trigger']);
  const queue = ['Gmail Trigger'];
  while (queue.length) {
    const name = queue.shift();
    for (const branch of workflow.connections[name]?.main ?? []) {
      for (const { node } of branch) if (!seen.has(node)) { seen.add(node); queue.push(node); }
    }
  }
  assert.deepEqual([...seen].sort(), workflow.nodes.map((n) => n.name).sort());
});

test('every category has a Gmail label configured', () => {
  const settings = JSON.parse(byName.Settings.parameters.jsonOutput);
  const categories = readFileSync(new URL('../src/parse-result.js', import.meta.url), 'utf8')
    .match(/const CATEGORIES = \[([^\]]+)\]/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(Object.keys(settings.labels).sort(), categories.sort());
});

test('no real credentials are stored in the export', () => {
  for (const n of workflow.nodes) for (const c of Object.values(n.credentials ?? {})) assert.equal(c.id, '');
  assert.doesNotMatch(JSON.stringify(workflow), /sk-ant-|sk-[A-Za-z0-9]{20}|xox[bp]-/);
});
