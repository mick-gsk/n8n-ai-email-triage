// Runs an n8n Code node source file outside n8n, with $input and $() mocked.
//   runCodeNode(new URL('../src/parse.js', import.meta.url), { input, nodes })
import { readFileSync } from 'node:fs';

export function runCodeNode(file, { input = [], nodes = {} } = {}) {
  const source = readFileSync(file, 'utf8');
  const wrap = (items) => ({ all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] }) });
  const $input = wrap(input);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Code node referenced unknown node "${name}"`);
    return wrap(nodes[name]);
  };
  return new Function('$input', '$', source)($input, $).map((item) => item.json);
}
