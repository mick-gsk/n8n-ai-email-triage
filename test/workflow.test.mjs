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

test('Ask Claude retries, times out and hands failures on instead of stopping', () => {
  const ask = byName['Ask Claude'];
  assert.equal(ask.retryOnFail, true);
  assert.ok(ask.maxTries >= 3 && ask.maxTries <= 5, 'n8n allows 2 to 5 tries');
  assert.ok(ask.waitBetweenTries > 0 && ask.waitBetweenTries <= 5000, 'n8n caps the wait at 5000 ms');
  assert.equal(ask.onError, 'continueRegularOutput', 'a failed email must still be labelled and logged');
  assert.ok(ask.parameters.options.timeout > 0);
  assert.ok(ask.parameters.options.batching.batch.batchSize > 0);
});

test('trigger only picks up unread inbox mail and processed mail is labelled', () => {
  const { filters } = byName['Gmail Trigger'].parameters;
  assert.equal(filters.readStatus, 'unread');
  assert.deepEqual(filters.labelIds, ['INBOX']);
  assert.equal(byName['Gmail Trigger'].parameters.simple, false, 'labelIds are needed to skip mail that was already processed');
  assert.ok(workflow.connections['Parse AI result'].main[0].some((c) => c.node === 'Add Gmail label'));
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

// Evaluates an n8n expression string ("=...{{ js }}...") for one item, enough for simple templates.
const render = (expr, json) => expr.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, js) => new Function('$json', `return (${js});`)(json));

test('Slack alert escapes email fields so they cannot ping the channel or add links', () => {
  const text = render(byName['Alert on Slack'].parameters.text, {
    category: 'support', from: 'x@example.com', subject: '<!channel> urgent', summary: 'Click <https://evil.example|here> & pay',
  });
  assert.doesNotMatch(text, /<!channel>|<https:/);
  assert.match(text, /&lt;!channel&gt; urgent/);
  assert.match(text, /&amp; pay/);
});

test('Google Sheets writes values as text, not formulas', () => {
  assert.equal(byName['Log to Google Sheets'].parameters.options.cellFormat, 'RAW');
});
