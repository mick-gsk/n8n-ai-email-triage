import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { settings, src } from './helpers.mjs';

const message = (binary, extra = {}) => ({
  json: {
    id: '19a0f1',
    threadId: '19a0f1',
    labelIds: ['INBOX'],
    from: { value: [{ address: 'billing@supplier.example' }] },
    subject: 'Invoice 42',
    ...extra,
  },
  binary,
});
const file = (fileName, mimeType, bytes) => ({ fileName, mimeType, bytes, id: `filesystem-v2:${fileName}` });

function split(messages, s = settings) {
  return runCodeNode(src('split-attachments.js'), {
    items: true,
    nodes: { 'Gmail Trigger': messages, Settings: [{ json: s }] },
  });
}

describe('Split attachments', () => {
  test('one item per PDF or image, with the file as binary "file"', () => {
    const pdf = file('invoice.pdf', 'application/pdf', 80_000);
    const scan = file('receipt.jpg', 'image/jpeg', 900_000);
    const out = split([message({ attachment_0: pdf, attachment_1: scan })]);
    assert.deepEqual(
      out.map((o) => [o.json.file_name, o.json.media_type, o.json.status]),
      [
        ['invoice.pdf', 'application/pdf', 'pending'],
        ['receipt.jpg', 'image/jpeg', 'pending'],
      ],
    );
    assert.equal(out[0].binary.file, pdf);
    assert.equal(out[0].json.message_id, '19a0f1');
    assert.equal(out[0].json.email_from, 'billing@supplier.example');
    assert.equal(out[0].json.gmail_link, 'https://mail.google.com/mail/u/0/#all/19a0f1');
  });

  test('ignores other file types and small images such as signature logos', () => {
    const out = split([
      message({
        attachment_0: file('invoice.pdf', 'application/pdf', 50_000),
        attachment_1: file('logo.png', 'image/png', 4_000),
        attachment_2: file('agb.docx', 'application/msword', 30_000),
      }),
    ]);
    assert.deepEqual(
      out.map((o) => o.json.file_name),
      ['invoice.pdf'],
    );
  });

  test('a PDF sent as application/octet-stream is recognised by its extension', () => {
    const [out] = split([message({ attachment_0: file('RE-1.PDF', 'application/octet-stream', 50_000) })]);
    assert.equal(out.json.media_type, 'application/pdf');
  });

  test('an email without a usable file becomes a review item instead of disappearing', () => {
    const [out] = split([message({ attachment_0: file('Rechnung.docx', 'application/msword', 30_000) })]);
    assert.equal(out.json.status, 'review');
    assert.deepEqual(out.json.reasons, ['no PDF or image attachment (found: Rechnung.docx)']);
    assert.equal(out.binary, undefined);
  });

  test('files over the size limit go to review', () => {
    const out = split([
      message({
        attachment_0: file('big.pdf', 'application/pdf', 12 * 1024 * 1024),
        attachment_1: file('photo.jpg', 'image/jpeg', 4 * 1024 * 1024),
      }),
    ]);
    assert.deepEqual(
      out.map((o) => [o.json.status, o.json.reasons[0]]),
      [
        ['review', 'file too large for automatic reading (12.0 MB, limit 10.0 MB)'],
        ['review', 'file too large for automatic reading (4.0 MB, limit 3.8 MB)'],
      ],
    );
  });

  test('size of in-memory binary data is taken from its base64 length', () => {
    const data = Buffer.alloc(30_000).toString('base64');
    const [out] = split([message({ attachment_0: { data, mimeType: 'image/png', fileName: 'scan.png' } })]);
    assert.equal(out.json.status, 'pending');
    assert.equal(out.json.file_bytes, 30_000);
  });

  test('skips mail that this workflow already labelled', () => {
    const pdf = { attachment_0: file('a.pdf', 'application/pdf', 1000) };
    const out = split([
      message(pdf, { id: 'aa1', labelIds: ['INBOX', 'Label_DONE'] }),
      message(pdf, { id: 'aa2', labelIds: ['INBOX', 'Label_REVIEW'] }),
      message(pdf, { id: 'aa3' }),
    ]);
    assert.deepEqual(
      out.map((o) => o.json.message_id),
      ['aa3'],
    );
  });

  test('no Gmail link for a message ID that is not hex', () => {
    const [out] = split([message({ attachment_0: file('a.pdf', 'application/pdf', 1000) }, { id: 'x"><script>' })]);
    assert.equal(out.json.gmail_link, '');
  });
});
