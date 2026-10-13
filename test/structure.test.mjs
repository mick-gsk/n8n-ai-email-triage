// Checks that apply to every workflow export in the collection.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { repoRoot } from '../lib/n8n.mjs';

const exports = ['shared', 'workflows'].flatMap((group) =>
  readdirSync(join(repoRoot, group)).flatMap((dir) =>
    readdirSync(join(repoRoot, group, dir))
      .filter((f) => f.endsWith('.json') && f !== 'package.json')
      .map((f) => join(repoRoot, group, dir, f)),
  ),
);

const isTrigger = (n) => /trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook';

test('the collection has workflow exports', () => {
  assert.ok(exports.length >= 2);
});

for (const file of exports) {
  const name = relative(repoRoot, file);
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

  test(`${name}: node names and IDs are unique`, () => {
    assert.equal(Object.keys(byName).length, wf.nodes.length);
    assert.equal(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
  });

  test(`${name}: every connection points to an existing node`, () => {
    for (const [from, outputs] of Object.entries(wf.connections)) {
      assert.ok(byName[from], `unknown source ${from}`);
      for (const branches of Object.values(outputs))
        for (const branch of branches)
          for (const { node } of branch) assert.ok(byName[node], `${from} -> unknown ${node}`);
    }
  });

  test(`${name}: every node is reachable from a trigger`, () => {
    // AI sub-nodes (models, tools, memory) connect into their parent through ai_* outputs, so
    // all connection types count, in both directions for ai_* links.
    const edges = new Map(wf.nodes.map((n) => [n.name, new Set()]));
    for (const [from, outputs] of Object.entries(wf.connections))
      for (const [type, branches] of Object.entries(outputs))
        for (const branch of branches)
          for (const { node } of branch) {
            edges.get(from).add(node);
            if (type.startsWith('ai_')) edges.get(node).add(from);
          }
    const seen = new Set(wf.nodes.filter(isTrigger).map((n) => n.name));
    assert.ok(seen.size > 0, 'no trigger node');
    const queue = [...seen];
    while (queue.length)
      for (const next of edges.get(queue.shift()))
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    const unreachable = wf.nodes
      .map((n) => n.name)
      .filter((n) => !seen.has(n) && byName[n].type !== 'n8n-nodes-base.stickyNote');
    assert.deepEqual(unreachable, []);
  });

  test(`${name}: no credentials or secrets in the export`, () => {
    for (const n of wf.nodes) for (const c of Object.values(n.credentials ?? {})) assert.equal(c.id, '', n.name);
    assert.doesNotMatch(JSON.stringify(wf), /sk-ant-|sk-[A-Za-z0-9]{20}|xox[bp]-|pat-[a-z0-9]{2,4}-[0-9a-f]{8}/);
  });

  test(`${name}: uses execution order v1`, () => {
    assert.equal(wf.settings.executionOrder, 'v1');
  });
}
