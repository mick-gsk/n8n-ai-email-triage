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
  assert.equal(first.email.body, 'Hi, since 8am none of our customers can pay. The checkout shows error 500. Please help ASAP. Anna');
});

test('prepare: falls back to HTML without styles or tags', () => {
  const [, second] = prepare();
  assert.equal(second.email.body, 'New features this month!');
});

test('prepare: builds an Anthropic Messages API request from Settings', () => {
  const [first] = prepare();
  assert.equal(first.request.model, 'claude-haiku-5-5');
  assert.equal(first.request.system, 'SORT EMAIL');
  assert.match(first.request.messages[0].content, /^From: anna@customer\.example\nSubject: Checkout broken/);
});

test('prepare: truncates very long emails', () => {
  const long = [{ ...emails[0], text: 'x'.repeat(20000) }];
  const [out] = runCodeNode('prepare-email.js', { nodes: { 'Gmail Trigger': long, Settings: [settings] } });
  assert.equal(out.email.body.length, 6000);
});

test('parse: valid reply becomes a triage record', () => {
  const reply = JSON.stringify({
    category: 'support', priority: 'high', summary: 'Checkout returns error 500 for all customers.',
    needs_reply: true, language: 'en', draft_reply: 'Hi Anna, we are on it. Best regards',
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
  const [out] = parse(['Sure! Here you go:\n```json\n{"category":"sales","priority":"normal","summary":"Asks for a quote.","needs_reply":false}\n```', '{}']);
  assert.equal(out.category, 'sales');
});

test('parse: unknown category is flagged for review, not dropped', () => {
  const [out] = parse(['{"category":"urgent","priority":"critical","summary":"x","needs_reply":true,"draft_reply":"hi"}', '{}']);
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

test('parse: no draft is kept when needs_reply is false', () => {
  const [out] = parse(['{"category":"newsletter","priority":"low","summary":"x","needs_reply":false,"draft_reply":"Thanks!"}', '{}']);
  assert.equal(out.draft_reply, '');
});
