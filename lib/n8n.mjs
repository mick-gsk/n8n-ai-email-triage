// Helpers for the build scripts in workflows/*/build.mjs and shared/*/build.mjs. Each build script
// describes one workflow in code and writes it as an importable n8n export next to itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns read(path) for files relative to the directory of the calling module. */
export const reader = (moduleUrl) => (p) => readFileSync(join(dirname(fileURLToPath(moduleUrl)), p), 'utf8');

// node('Name', 'type', typeVersion, [x, y], { parameters, ...other node fields })
export const node = (name, type, typeVersion, position, { parameters = {}, ...extra } = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

// link('A', null, ['B', 'C']): output 0 goes to A, output 1 nowhere, output 2 to B and C.
export const link = (...outputs) => ({
  main: outputs.map((t) => (t ? [t].flat().map((n) => ({ node: n, type: 'main', index: 0 })) : [])),
});

// One condition for an If or Filter node (version 2 condition format).
export const ifCondition = (id, leftValue, rightValue, operator) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
});

// Escapes a field for Slack message text: Slack reads <!channel>, <!here> and <url|text> as
// mentions and links, so &, < and > in outside data are escaped as its docs require.
export const slackSafe = (field) =>
  `{{ String($json.${field}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}`;

// Credential references without IDs: n8n asks for the credential on import.
export const credential = (type, name) => ({ [type]: { id: '', name } });

export const workflow = (name, nodes, connections, settings = {}) => ({
  name,
  nodes,
  connections,
  settings: { executionOrder: 'v1', ...settings },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
});

/** Writes the export next to the calling build script. */
export function writeWorkflow(moduleUrl, file, wf) {
  const path = join(dirname(fileURLToPath(moduleUrl)), file);
  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
  console.log(`${relative(repoRoot, path)}: ${wf.nodes.length} nodes`);
}
