// Measures how well the prompt sorts a small labelled set of emails.
//   ANTHROPIC_API_KEY=... npm run eval
// Uses the same prompt and parsing code as the workflow.
import { readFileSync } from 'node:fs';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

const src = (file) => new URL(`../src/${file}`, import.meta.url);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('Set ANTHROPIC_API_KEY to run the evaluation.');
  process.exit(1);
}
const model = process.env.MODEL ?? 'claude-haiku-5-5';
const prompt = readFileSync(new URL('../src/prompt.md', import.meta.url), 'utf8').trim();
const cases = JSON.parse(readFileSync(new URL('./emails.json', import.meta.url), 'utf8'));

const triggerItems = cases.map((c, i) => ({
  id: String(i),
  threadId: String(i),
  from: { text: c.from },
  subject: c.subject,
  text: c.body,
}));
const prepared = runCodeNode(src('prepare-email.js'), {
  nodes: { 'Gmail Trigger': triggerItems, Settings: [{ model, systemPrompt: prompt }] },
});

const replies = [];
for (const { request } of prepared) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(request),
  });
  replies.push(await res.json());
}
const results = runCodeNode(src('parse-result.js'), { input: replies, nodes: { 'Prepare email': prepared } });

let category = 0;
let priority = 0;
results.forEach((r, i) => {
  const exp = cases[i].expected;
  const ok = r.category === exp.category;
  category += ok;
  priority += r.priority === exp.priority;
  console.log(
    `${ok ? 'ok  ' : 'MISS'} ${cases[i].subject.padEnd(40)} -> ${r.category}/${r.priority} (expected ${exp.category}/${exp.priority})`,
  );
});
console.log(
  `\ncategory accuracy ${category}/${results.length}, priority accuracy ${priority}/${results.length} (model ${model})`,
);
