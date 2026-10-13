import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { src } from './helpers.mjs';

const settings = { maxFileMB: 1, processedLabelId: 'Label_DONE', reviewLabelId: 'Label_REVIEW' };
const email = (binary, json = {}) => ({
  json: { id: '19a0f1', threadId: '19a0f1', from: { value: [{ address: 'rechnung@kornblume.example' }] }, ...json },
  binary,
});
const file = (fileName, mimeType, bytes = 1000) => ({ fileName, mimeType, bytes });
const split = (...emails) =>
  runCodeNode(src('split-attachments.js'), {
    items: true,
    nodes: { Settings: [{ json: settings }], 'Gmail Trigger': emails },
  });

test('one item per XML or PDF attachment; other files are ignored', () => {
  const out = split(
    email({
      attachment_0: file('RE-1.xml', 'application/xml'),
      attachment_1: file('RE-1.pdf', 'application/pdf'),
      attachment_2: file('logo.png', 'image/png'),
      attachment_3: file('RE-2.xml', 'application/octet-stream'),
      attachment_4: file('xrechnung.xml', 'application/x-xrechnung+xml'),
      attachment_5: file('RE-3.pdf', 'text/plain'),
    }),
  );
  assert.deepEqual(
    out.map((i) => [i.json.file_name, i.json.media_type, i.json.status]),
    [
      ['RE-1.xml', 'application/xml', 'pending'],
      ['RE-1.pdf', 'application/pdf', 'pending'],
      ['RE-2.xml', 'application/xml', 'pending'],
      ['xrechnung.xml', 'application/xml', 'pending'],
    ],
  );
  assert.equal(out[0].binary.file.fileName, 'RE-1.xml');
  assert.equal(out[0].json.email_from, 'rechnung@kornblume.example');
  assert.equal(out[0].json.gmail_link, 'https://mail.google.com/mail/u/0/#all/19a0f1');
});

test('a file over the limit and an email without XML or PDF go to review', () => {
  const [big, none] = split(
    email({ attachment_0: file('RE-1.pdf', 'application/pdf', 3 * 1024 * 1024) }),
    email({ attachment_0: file('Rechnung.docx', 'application/msword') }, { id: '19a0f2' }),
  );
  assert.deepEqual(big.json.reasons, ['file too large (3.0 MB, limit 1 MB)']);
  assert.equal(big.binary, undefined);
  assert.equal(none.json.status, 'review');
  assert.deepEqual(none.json.reasons, ['no XML or PDF attachment (found: Rechnung.docx)']);
});

test('mail this workflow has already labelled is skipped', () => {
  assert.deepEqual(split(email({ attachment_0: file('RE-1.xml', 'text/xml') }, { labelIds: ['Label_DONE'] })), []);
});
