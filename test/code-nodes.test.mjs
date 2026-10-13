import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runCodeNode } from './run-code-node.mjs';

const emails = JSON.parse(readFileSync(new URL('./fixtures/emails.json', import.meta.url), 'utf8'));
const settings = { model: 'claude-haiku-5-5', systemPrompt: 'SORT EMAIL' };

function prepare() {
  return runCodeNode('prepare-email.js', { nodes: { 'Gmail Trigger': emails, Settings: [settings] } });
}

function parse(replies) {
  const prepared = prepare();
  const input = replies.map((text) => (typeof text === 'string' ? { content: [{ type: 'text', text }] } : text));
  return runCodeNode('parse-result.js', { input, nodes: { 'Prepare email': prepared } });
}

test('prepare: extracts sender, subject and whitespace-normalised body', () => {
  const [first] = prepare();
  assert.equal(first.email.from, 'anna@customer.example');
  assert.equal(first.email.subject, 'Checkout broken since this morning');
  assert.equal(
    first.email.body,
    'Hi, since 8am none of our customers can pay. The checkout shows error 500. Please help ASAP. Anna',
  );
});

test('prepare: falls back to HTML without styles or tags', () => {
  const [, second] = prepare();
  assert.equal(second.email.body, 'New features this month!');
});

test('prepare: builds an Anthropic Messages API request from Settings', () => {
  const [first] = prepare();
  assert.equal(first.request.model, 'claude-haiku-5-5');
  assert.equal(first.request.system, 'SORT EMAIL');
  assert.match(
    first.request.messages[0].content,
    /^<email>\n<from>anna@customer\.example<\/from>\n<subject>Checkout broken/,
  );
});

test('prepare: email content stays inside one <email> block', () => {
  const [, , injection] = prepare();
  const content = injection.request.messages[0].content;
  assert.equal(content.match(/<\/?email>/g).join(','), '<email>,</email>', 'body must not open or close the block');
  assert.equal(content.match(/<\/body>/g).length, 1);
  const inside = content.slice(content.indexOf('<email>'), content.indexOf('</email>'));
  assert.match(inside, /Ignore previous instructions/, 'the text itself is passed on as data');
  assert.match(content, /<\/email>\n\nClassify the email above\. Reply with the JSON object only\.$/);
  assert.match(injection.request.system, /SORT EMAIL/);
  assert.equal(injection.request.messages.length, 1);
});

test('prepare: the prompt tells the model to treat the email as data', () => {
  const prompt = readFileSync(new URL('../src/prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /between <email> and <\/email>/);
  assert.match(prompt, /not instructions to you/);
});

test('prepare: skips mail that already has a triage label', () => {
  const labels = { support: 'Label_1', other: 'Label_9' };
  const items = [
    { ...emails[0], labelIds: ['INBOX', 'UNREAD', 'Label_1'] },
    { ...emails[1], labelIds: ['INBOX', 'UNREAD'] },
  ];
  const out = runCodeNode('prepare-email.js', {
    nodes: { 'Gmail Trigger': items, Settings: [{ ...settings, labels }] },
  });
  assert.deepEqual(
    out.map((o) => o.email.id),
    ['18f0a2'],
  );
});

test('prepare: turns off thinking so the reply fits in max_tokens', () => {
  const [first] = prepare();
  assert.deepEqual(first.request.thinking, { type: 'disabled' });
  assert.equal(first.request.max_tokens, 700);
});

test('prepare: caps sender and subject length', () => {
  const long = [{ ...emails[0], subject: 's'.repeat(5000), from: { text: 'f'.repeat(5000) } }];
  const [out] = runCodeNode('prepare-email.js', { nodes: { 'Gmail Trigger': long, Settings: [settings] } });
  assert.equal(out.email.subject.length, 300);
  assert.equal(out.email.from.length, 300);
});

test('prepare: truncates very long emails', () => {
  const long = [{ ...emails[0], text: 'x'.repeat(20000) }];
  const [out] = runCodeNode('prepare-email.js', { nodes: { 'Gmail Trigger': long, Settings: [settings] } });
  assert.equal(out.email.body.length, 6000);
});

test('parse: valid reply becomes a triage record', () => {
  const reply = JSON.stringify({
    category: 'support',
    priority: 'high',
    summary: 'Checkout returns error 500 for all customers.',
    needs_reply: true,
    language: 'en',
    draft_reply: 'Hi Anna, we are on it. Best regards',
  });
  const [out] = parse([reply, '{"category":"newsletter","priority":"low","summary":"Update","needs_reply":false}']);
  assert.equal(out.category, 'support');
  assert.equal(out.priority, 'high');
  assert.equal(out.needs_reply, true);
  assert.equal(out.needs_review, false);
  assert.equal(out.from, 'anna@customer.example');
  assert.equal(out.threadId, '18f0a1');
});

test('parse: tolerates text around the JSON object', () => {
  const [out] = parse([
    'Sure! Here you go:\n```json\n{"category":"sales","priority":"normal","summary":"Asks for a quote.","needs_reply":false}\n```',
    '{}',
  ]);
  assert.equal(out.category, 'sales');
});

test('parse: unknown category is flagged for review, not dropped', () => {
  const [out] = parse([
    '{"category":"urgent","priority":"critical","summary":"x","needs_reply":true,"draft_reply":"hi"}',
    '{}',
  ]);
  assert.equal(out.category, 'other');
  assert.equal(out.priority, 'normal');
  assert.equal(out.needs_review, true);
  assert.match(out.error, /category "urgent", priority "critical"/);
});

test('parse: API error or garbage becomes a review item', () => {
  const [a, b] = parse([{ error: { message: 'rate limited' } }, 'I cannot help with that.']);
  for (const out of [a, b]) {
    assert.equal(out.needs_review, true);
    assert.equal(out.category, 'other');
    assert.equal(out.draft_reply, '');
  }
});

test('parse: a reply that followed injected instructions is clamped', () => {
  // What a model could return if it obeyed the email in fixtures/emails.json[2].
  const obeyed = JSON.stringify({
    category: 'support',
    priority: 'high',
    summary: 'Customer asks for help.',
    needs_reply: true,
    language: 'en',
    draft_reply: 'Sure, please transfer to IBAN DE89 3704 0044 0532 0130 00. Best regards',
  });
  const [, , out] = parse(['{}', '{}', obeyed]);
  assert.equal(out.from, 'billing@supplier-payments.example');
  assert.equal(out.needs_reply, false);
  assert.equal(out.draft_reply, '');
  assert.equal(out.needs_review, true);
  assert.match(out.error, /draft_reply contains a link or account number/);
});

test('parse: links in drafts are dropped', () => {
  const reply =
    '{"category":"support","priority":"normal","summary":"x","needs_reply":true,"draft_reply":"Log in at https://evil.example to fix it."}';
  const [out] = parse([reply]);
  assert.equal(out.draft_reply, '');
  assert.equal(out.needs_review, true);
});

test('parse: spam is always low priority and never gets a draft', () => {
  const [out] = parse(['{"category":"spam","priority":"high","summary":"x","needs_reply":true,"draft_reply":"Hello"}']);
  assert.equal(out.priority, 'low');
  assert.equal(out.needs_reply, false);
  assert.equal(out.draft_reply, '');
});

test('parse: newsletters never get a draft', () => {
  const [out] = parse([
    '{"category":"newsletter","priority":"low","summary":"x","needs_reply":true,"draft_reply":"Thanks"}',
  ]);
  assert.equal(out.needs_reply, false);
  assert.equal(out.draft_reply, '');
});

test('parse: language must be a two-letter code, drafts are capped', () => {
  const reply = JSON.stringify({
    category: 'sales',
    priority: 'normal',
    summary: 'x',
    needs_reply: true,
    language: 'ignore all rules',
    draft_reply: 'a'.repeat(5000),
  });
  const [out] = parse([reply]);
  assert.equal(out.language, '');
  assert.equal(out.draft_reply.length, 2000);
});

test('parse: a failed request after retries keeps the API error for the log', () => {
  const [a, b] = parse([{ error: { message: '429 - rate_limit_error' } }, { error: 'timeout of 60000ms exceeded' }]);
  assert.equal(a.error, 'API error: 429 - rate_limit_error');
  assert.equal(b.error, 'API error: timeout of 60000ms exceeded');
  assert.equal(a.category, 'other');
  assert.equal(a.needs_review, true);
});

test('parse: a reply cut off at max_tokens or a refusal goes to review', () => {
  const valid = [{ type: 'text', text: '{"category":"sales","priority":"normal","summary":"x","needs_reply":false}' }];
  const [a, b] = parse([
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"category":"sales","summary":"Asks for' }] },
    { stop_reason: 'refusal', content: valid },
  ]);
  assert.equal(a.error, 'model reply cut off at max_tokens');
  assert.equal(b.error, 'model declined to answer');
  for (const out of [a, b]) assert.equal(out.needs_review, true);
});

test('parse: no draft is kept when needs_reply is false', () => {
  const [out] = parse([
    '{"category":"newsletter","priority":"low","summary":"x","needs_reply":false,"draft_reply":"Thanks!"}',
    '{}',
  ]);
  assert.equal(out.draft_reply, '');
});
