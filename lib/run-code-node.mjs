// Runs an n8n Code node source file outside n8n, with $input and $() mocked.
//   runCodeNode(new URL('../src/parse.js', import.meta.url), { input, nodes })
// Input and output are item JSON by default. With { items: true } they are whole n8n items
// ({ json, binary }), for nodes that read or pass on binary data.
import { readFileSync } from 'node:fs';

export function runCodeNode(file, { input = [], nodes = {}, items = false } = {}) {
  const source = readFileSync(file, 'utf8');
  const toItem = (x) => (items ? x : { json: x });
  const wrap = (list) => ({ all: () => list.map(toItem), first: () => toItem(list[0]) });
  const $input = wrap(input);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Code node referenced unknown node "${name}"`);
    return wrap(nodes[name]);
  };
  const out = new Function('$input', '$', source)($input, $);
  return items ? out : out.map((item) => item.json);
}
