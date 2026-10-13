import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

import { exported, secret, settings, src } from './fixtures.mjs';

const post = (body, { headers = { 'x-lead-secret': secret }, query = {} } = {}) => ({
  headers,
  params: {},
  query,
  body,
});

const validate = (req, s = settings) =>
  runCodeNode(src('validate-lead.js'), { nodes: { 'Lead webhook': [req], Settings: [s] } })[0];

const form = {
  name: '  Jana   Weber ',
  Email: 'Jana.Weber@Bakery-Weber.example',
  company: '<b>Bäckerei</b> Weber',
  phone: '+49 30 1234567',
  message: 'Hello,\r\n\r\n\r\n\r\nwe need a <script>alert(1)</script>new website.\u0000 Budget 12,000 EUR.',
  utm_source: 'google',
};

test('validate: accepts a form and normalises it', () => {
  const out = validate(post(form));
  assert.equal(out.status, 'accepted');
  assert.deepEqual(out.response, { status: 202, body: { ok: true } });
  const { receivedAt, ...rest } = out.lead;
  assert.match(receivedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(rest, {
    email: 'jana.weber@bakery-weber.example',
    firstName: 'Jana',
    lastName: 'Weber',
    company: 'Bäckerei Weber',
    phone: '+49 30 1234567',
    website: '',
    message: 'Hello,\n\nwe need a new website. Budget 12,000 EUR.',
    truncated: false,
  });
});

test('validate: separate first and last name fields win over a full name', () => {
  const out = validate(
    post({ email: 'a@b.example', message: 'x', name: 'Full Name', first_name: 'Ann', last_name: 'Lee' }),
  );
  assert.equal(out.lead.firstName, 'Ann');
  assert.equal(out.lead.lastName, 'Lee');
});

test('validate: wrong, missing or prefix secret gets 401', () => {
  for (const headers of [
    { 'x-lead-secret': 'wrong' },
    {},
    { 'x-lead-secret': secret.slice(0, -1) },
    { 'x-lead-secret': secret + 'x' },
  ]) {
    const out = validate(post(form, { headers }));
    assert.equal(out.status, 'unauthorized');
    assert.deepEqual(out.response, { status: 401, body: { ok: false, error: 'unauthorized' } });
    assert.equal(out.lead, null);
  }
});

test('validate: the secret in the query string only counts when enabled', () => {
  const req = post(form, { headers: {}, query: { token: secret } });
  assert.equal(validate(req).status, 'unauthorized');
  assert.equal(validate(req, { ...settings, secretQueryParam: 'token' }).status, 'accepted');
});

test('validate: the exported placeholder secret, or a short one, is refused', () => {
  for (const webhookSecret of [exported.webhookSecret, 'short', '']) {
    const out = validate(post(form, { headers: { 'x-lead-secret': webhookSecret } }), { ...settings, webhookSecret });
    assert.equal(out.status, 'misconfigured');
    assert.equal(out.response.status, 500);
    assert.match(out.errors[0], /webhookSecret/);
  }
});

test('validate: a filled honeypot looks like success to the bot but goes no further', () => {
  const out = validate(post({ ...form, Fax: 'http://spam.example' }));
  assert.equal(out.status, 'bot');
  assert.deepEqual(out.response, { status: 202, body: { ok: true } });
  assert.equal(out.lead, null);
  assert.equal(validate(post({ ...form, fax: '  ' })).status, 'accepted');
});

test('validate: lists every problem in the 400 response', () => {
  const out = validate(
    post({
      email: 'jana@@example',
      message: '<p></p>',
      phone: 'call me maybe',
      website: 'javascript:alert(1)',
      company: { x: 1 },
    }),
  );
  assert.equal(out.status, 'invalid');
  assert.equal(out.response.status, 400);
  assert.deepEqual(out.response.body.errors, [
    'company must be text',
    'message is required',
    'email is not a valid address',
    'phone must be digits, optionally with spaces and + ( ) . / -',
    'website is not a valid domain or URL',
  ]);
});

test('validate: rejects malformed addresses', () => {
  for (const email of [
    'a@b',
    'a b@c.example',
    'a..b@c.example',
    '.a@c.example',
    'a.@c.example',
    '<a@c.example>',
    'a@-c.example',
  ]) {
    assert.equal(validate(post({ email, message: 'x' })).status, 'invalid', email);
  }
  for (const email of ['a+tag@c.example', 'first.last@sub.c-d.example', 'A@C.EXAMPLE'])
    assert.equal(validate(post({ email, message: 'x' })).status, 'accepted', email);
});

test('validate: a phone number needs at least one digit', () => {
  for (const phone of ['-----', '(  ) / .', '+++++'])
    assert.equal(validate(post({ email: 'a@b.example', message: 'x', phone })).status, 'invalid', phone);
  for (const phone of ['+49 (30) 123-45', '030/12345'])
    assert.equal(validate(post({ email: 'a@b.example', message: 'x', phone })).status, 'accepted', phone);
});

test('validate: website labels start and end with a letter or digit', () => {
  for (const website of ['-example.com', 'example-.com', 'www.-x.example', 'https://a..example'])
    assert.equal(validate(post({ email: 'a@b.example', message: 'x', website })).status, 'invalid', website);
  for (const website of ['bakery-weber.example', 'https://www.a1.example:8080/path?q=1'])
    assert.equal(validate(post({ email: 'a@b.example', message: 'x', website })).status, 'accepted', website);
});

test('validate: a body that is not an object gets 400', () => {
  for (const body of ['email=a@b.example', [], null, undefined]) {
    const out = validate(post(body));
    assert.equal(out.status, 'invalid');
    assert.deepEqual(out.errors, ['body must be a JSON object or form fields']);
  }
});

test('validate: long fields are cut and flagged', () => {
  const out = validate(post({ email: 'a@b.example', message: 'm'.repeat(9000), company: 'c'.repeat(500) }));
  assert.equal(out.lead.message.length, 5000);
  assert.equal(out.lead.company.length, 200);
  assert.equal(out.lead.truncated, true);
});

test('validate: numbers are accepted as text, unknown fields are dropped', () => {
  const out = validate(post({ email: 'a@b.example', message: 'x', phone: 4930123456, secret_field: 'drop me' }));
  assert.equal(out.lead.phone, '4930123456');
  assert.doesNotMatch(JSON.stringify(out.lead), /drop me/);
});
