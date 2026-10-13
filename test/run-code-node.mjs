// Runs an n8n Code node source file outside n8n, with $input and $() mocked.
import { readFileSync } from 'node:fs';

export function runCodeNode(file, { input = [], nodes = {} } = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const wrap = (items) => ({ all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] }) });
  const $input = wrap(input);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Code node referenced unknown node "${name}"`);
    return wrap(nodes[name]);
  };
  return new Function('$input', '$', source)($input, $).map((item) => item.json);
}
