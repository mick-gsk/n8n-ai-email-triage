// Checks the workflow exports against a real n8n instance (Docker image n8nio/n8n):
//
//  1. Every node type and typeVersion exists in that n8n version, and every top-level parameter
//     is one the node knows.
//  2. Every export imports with `n8n import:workflow`.
//  3. The cases in workflows/*/test/n8n.cases.mjs run with `n8n execute`. For a run, a copy of the
//     workflow is changed so it can execute without real accounts:
//       - the trigger becomes a Code node of the same name that emits the case's input items
//         (behind a Manual Trigger), so expressions like $('Gmail Trigger') still work;
//       - HTTP Request URLs and the base URL of AI credentials point to a local mock server that
//         answers with the case's responses and records every request;
//       - nodes that need any other account (Gmail, Slack, Sheets, ...) become Set nodes that
//         evaluate the node's expressions and pass them on under `sent`, so a case can check
//         what would have been sent;
//       - nodes listed in a case's `stubs` return fixed items instead.
//     Everything else (Code, If, Switch, Merge, AI agents, ...) runs as exported.
//
//   npm run check:n8n                     all workflows
//   npm run check:n8n -- email-triage     one workflow
//   N8N_IMAGE=docker.n8n.io/n8nio/n8n:2.43.4 npm run check:n8n
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { repoRoot } from '../lib/n8n.mjs';

const run = promisify(execFile);
const image = process.env.N8N_IMAGE ?? 'docker.n8n.io/n8nio/n8n:latest';
const only = process.argv.slice(2);
const volume = `n8n-check-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), 'n8n-check-'));
// The container runs as user node and writes the node catalog here.
chmodSync(work, 0o777);

// Node types that run unchanged. Anything else with credentials is replaced (see above).
const RUNS_AS_IS = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.set',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.dateTime',
  'n8n-nodes-base.crypto',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.executeWorkflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.extractFromFile',
  'n8n-nodes-base.convertToFile',
  'n8n-nodes-base.stopAndError',
  'n8n-nodes-base.stickyNote',
]);

// Credentials the check can fill with test values that point at the mock server.
const mockCredentials = (base) => ({
  httpHeaderAuth: { name: 'x-api-key', value: 'test-key' },
  anthropicApi: { apiKey: 'test-key', url: `${base}/api.anthropic.com` },
  openAiApi: { apiKey: 'test-key', url: `${base}/api.openai.com/v1` },
});

const docker = async (args, { input } = {}) => {
  const env = ['-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_RUNNERS_ENABLED=true'];
  const p = run(
    'docker',
    [
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${volume}:/home/node/.n8n`,
      '-v',
      `${work}:/check`,
      ...env,
      image,
      ...args,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (input) p.child.stdin.end(input);
  return p;
};

const findExports = () =>
  ['shared', 'workflows'].flatMap((group) =>
    readdirSync(join(repoRoot, group))
      .filter((dir) => !only.length || only.includes(dir))
      .map((dir) => join(repoRoot, group, dir)),
  );

// --- 1. node types and parameters -------------------------------------------------------------

async function checkNodeTypes(files) {
  await docker(['export:nodes', '--output=/check/nodes.json']);
  const catalog = JSON.parse(readFileSync(join(work, 'nodes.json'), 'utf8'));
  const problems = [];
  for (const file of files) {
    const wf = JSON.parse(readFileSync(file, 'utf8'));
    for (const n of wf.nodes) {
      const variants = catalog.filter((d) => d.name === n.type);
      const desc = variants.find((d) => [d.version].flat().includes(n.typeVersion));
      if (!desc) {
        const versions = variants.flatMap((d) => [d.version].flat()).join(', ') || 'none';
        problems.push(
          `${relative(repoRoot, file)}: ${n.name}: ${n.type} v${n.typeVersion} not found (versions: ${versions})`,
        );
        continue;
      }
      const known = new Set(desc.properties.map((p) => p.name));
      for (const key of Object.keys(n.parameters))
        if (!known.has(key)) problems.push(`${relative(repoRoot, file)}: ${n.name}: unknown parameter "${key}"`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  console.log(`node types: ${files.length} exports match n8n's node catalog`);
}

// --- 2. import ---------------------------------------------------------------------------------

async function checkImport(files) {
  mkdirSync(join(work, 'import'));
  files.forEach((f, i) => {
    const wf = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(
      join(work, 'import', `${i}.json`),
      JSON.stringify({ ...wf, id: `import${String(i).padStart(10, '0')}` }),
    );
  });
  await docker(['import:workflow', '--separate', '--input=/check/import']);
  const { stdout, stderr } = await docker(['list:workflow']);
  const imported = (stdout + stderr).split('\n').filter((line) => line.includes('|'));
  assert.equal(imported.length, files.length, stdout + stderr);
  console.log(`import: ${files.length} exports imported`);
}

// --- 3. runs -----------------------------------------------------------------------------------

const isTrigger = (n) => /trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook';

// All "=..." expressions in a node's parameters, as [path, expression], with resource locators
// ({ __rl, value }) reduced to their value.
function expressions(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && v.startsWith('=')) out.push([path, v]);
    else if (v && typeof v === 'object' && v.__rl) {
      if (typeof v.value === 'string' && v.value.startsWith('=')) out.push([path, v.value]);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...expressions(v, path));
  }
  return out;
}

// "=Hi {{ $json.name }}!" -> ("Hi " + ($json.name) + "!"); "={{ x }}" -> (x)
function toJs(expr) {
  const parts = expr.slice(1).split(/\{\{([\s\S]+?)\}\}/);
  if (parts.length === 3 && !parts[0] && !parts[2]) return `(${parts[1]})`;
  return '(' + parts.map((p, i) => (i % 2 ? `String(${p})` : JSON.stringify(p))).join(' + ') + ')';
}

// { 'options.threadId': 1 } -> { options: { threadId: 1 } }
function unflatten(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.');
    let at = out;
    for (const k of keys.slice(0, -1)) at = at[k] ??= {};
    at[keys.at(-1)] = value;
  }
  return out;
}

const codeReturning = (items) => `return ${JSON.stringify(items.map((json) => ({ json })))};`;

function prepare(wf, testCase, ids, base) {
  const copy = structuredClone(wf);
  const stubs = testCase.stubs ?? {};
  const triggers = copy.nodes.filter(isTrigger);
  copy.nodes = copy.nodes.map((n) => {
    const keep = { id: n.id, name: n.name, position: n.position };
    if (n.name in stubs)
      return {
        ...keep,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: { jsCode: codeReturning(stubs[n.name]) },
      };
    if (isTrigger(n) && n.type !== 'n8n-nodes-base.executeWorkflowTrigger') {
      const input = testCase.input ?? [];
      return { ...keep, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: codeReturning(input) } };
    }
    if (n.type === 'n8n-nodes-base.httpRequest') {
      const url = n.parameters.url.replace(/^(=?)https?:\/\//, `$1${base}/`);
      const out = { ...n, parameters: { ...n.parameters, url } };
      if (n.credentials)
        out.credentials = Object.fromEntries(Object.keys(n.credentials).map((t) => [t, ids.credential(t)]));
      return out;
    }
    if (n.type === 'n8n-nodes-base.executeWorkflow' && testCase.subworkflows?.[n.name]) {
      const id = ids.subworkflow(testCase.subworkflows[n.name]);
      return { ...n, parameters: { ...n.parameters, workflowId: { __rl: true, mode: 'id', value: id } } };
    }
    const creds = Object.keys(n.credentials ?? {});
    if (creds.length && creds.every((t) => t in mockCredentials(base)))
      return { ...n, credentials: Object.fromEntries(creds.map((t) => [t, ids.credential(t)])) };
    if (!creds.length || RUNS_AS_IS.has(n.type)) return n;
    // One Set node that evaluates all of the node's expressions with their real types.
    const sent = expressions(n.parameters)
      .map(([path, expr]) => `${JSON.stringify(path)}: ${toJs(expr)}`)
      .join(', ');
    return {
      ...keep,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      parameters: {
        mode: 'raw',
        jsonOutput: `={{ { sent: (${unflatten})({ _node: ${JSON.stringify(n.type)}, ${sent} }) } }}`,
        includeOtherFields: true,
        options: {},
      },
    };
  });
  // Trigger code nodes need something to start them.
  const start = {
    id: 'check-start',
    name: 'Check start',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [-300, 0],
    parameters: {},
  };
  // A workflow with several triggers (a chat and an upload form, say) is started from the one the
  // case names.
  const starters = triggers.filter(
    (t) => t.type !== 'n8n-nodes-base.executeWorkflowTrigger' && (!testCase.trigger || t.name === testCase.trigger),
  );
  if (starters.length) {
    copy.nodes.push(start);
    copy.connections[start.name] = { main: [starters.map((t) => ({ node: t.name, type: 'main', index: 0 }))] };
  }
  return copy;
}

function startMock(routes, requests) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const [, host, ...rest] = req.url.split('/');
      const path = '/' + rest.join('/');
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // not JSON
      }
      const request = { method: req.method, host, path, headers: req.headers, body };
      requests.push(request);
      const key = `${req.method} ${host}${path.split('?')[0]}`;
      const route = routes[key];
      const reply = route
        ? route(request, requests.filter((r) => `${r.method} ${r.host}${r.path.split('?')[0]}` === key).length - 1)
        : { status: 404, body: { error: `no mock for ${key}` } };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}

function parseRun(stdout) {
  const start = stdout.indexOf('\n{\n') + 1 || stdout.indexOf('{\n');
  const end = stdout.lastIndexOf('\n}') + 2;
  const data = JSON.parse(stdout.slice(start, end));
  const runData = data.data.resultData.runData;
  return {
    status: data.status,
    error: data.data.resultData.error,
    ran: (name) => name in runData,
    out: (name, output = 0) => (runData[name]?.[0]?.data?.main?.[output] ?? []).map((i) => i.json),
    runData,
  };
}

async function runCases(dirs) {
  let count = 0;
  for (const dir of dirs) {
    const casesFile = join(dir, 'test', 'n8n.cases.mjs');
    if (!existsSync(casesFile)) continue;
    const { cases } = await import(pathToFileURL(casesFile).href);
    for (const testCase of cases) {
      const requests = [];
      const server = await startMock(testCase.http ?? {}, requests);
      const base = `http://host.docker.internal:${server.address().port}`;
      const caseDir = join(work, `case-${count}`);
      mkdirSync(caseDir);
      const credentials = [];
      const workflows = [];
      const prefix = `c${String(count).padStart(3, '0')}`;
      const ids = {
        credential(type) {
          const id = `${prefix}cred${type.slice(0, 8).padEnd(8, 'x')}`;
          if (!credentials.some((c) => c.id === id))
            credentials.push({
              id,
              name: `${type} (check)`,
              type,
              data: mockCredentials(base)[type] ?? { accessToken: 'test-token', apiKey: 'test-key' },
            });
          return { id, name: `${type} (check)` };
        },
        subworkflow(file) {
          const id = `${prefix}sub${String(workflows.length).padStart(9, '0')}`;
          const sub = JSON.parse(readFileSync(join(dir, file), 'utf8'));
          workflows.push({ ...prepare(sub, {}, ids, base), id });
          return id;
        },
      };
      const wf = JSON.parse(readFileSync(join(dir, testCase.workflow ?? 'workflow.json'), 'utf8'));
      const mainId = `${prefix}main00000000`;
      workflows.unshift({ ...prepare(wf, testCase, ids, base), id: mainId });
      mkdirSync(join(caseDir, 'workflows'));
      workflows.forEach((w, j) => writeFileSync(join(caseDir, 'workflows', `${j}.json`), JSON.stringify(w)));
      const rel = `/check/case-${count}`;
      if (credentials.length) {
        writeFileSync(join(caseDir, 'credentials.json'), JSON.stringify(credentials));
        await docker(['import:credentials', `--input=${rel}/credentials.json`]);
      }
      await docker(['import:workflow', '--separate', `--input=${rel}/workflows`]);
      const label = `${relative(repoRoot, dir)}: ${testCase.name}`;
      let stdout;
      try {
        ({ stdout } = await docker(['execute', `--id=${mainId}`, '--rawOutput']));
      } catch (e) {
        stdout = e.stdout;
        if (!testCase.expectFailure) {
          server.close();
          throw new Error(`${label}: execution failed\n${String(e.stdout).slice(-3000)}\n${e.stderr}`);
        }
      }
      server.close();
      const result = parseRun(stdout);
      result.requests = requests;
      if (!testCase.expectFailure) assert.equal(result.status, 'success', `${label}: ${JSON.stringify(result.error)}`);
      await testCase.check(result, assert);
      console.log(`run: ${label}`);
      count++;
    }
  }
  console.log(`runs: ${count} cases passed`);
}

try {
  const dirs = findExports();
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(d, f)),
  );
  const { stdout } = await docker(['--version']);
  console.log(`n8n ${stdout.trim().split('\n').pop()} (${image})`);
  await checkNodeTypes(files);
  await checkImport(files);
  await runCases(dirs);
} finally {
  await run('docker', ['volume', 'rm', '-f', volume]).catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
