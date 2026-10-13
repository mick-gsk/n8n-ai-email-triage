import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';
import { settings, src } from './helpers.mjs';

const PDF = Buffer.from('%PDF-1.4 test').toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');

function build(files) {
  const input = files.map(([fileBase64, media_type]) => ({
    json: { message_id: 'm1', file_name: 'f', media_type, fileBase64 },
    binary: { file: { id: 'bin' } },
  }));
  return runCodeNode(src('build-request.js'), { items: true, input, nodes: { Settings: [{ json: settings }] } });
}

describe('Build request', () => {
  test('a PDF becomes a document block with base64 source', () => {
    const [out] = build([[PDF, 'application/pdf']]);
    const { request } = out.json;
    assert.equal(request.model, 'claude-sonnet-5-5');
    assert.equal(request.system, 'EXTRACT');
    assert.deepEqual(request.output_config, {
      effort: 'low',
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
    assert.deepEqual(request.messages[0].content[0], {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF },
    });
    assert.equal(request.messages[0].content[1].type, 'text');
    assert.equal(request.thinking, undefined, 'Sonnet 5.5 rejects thinking: disabled');
  });

  test('an image becomes an image block', () => {
    const [out] = build([[JPEG, 'image/jpeg']]);
    assert.deepEqual(out.json.request.messages[0].content[0].source.media_type, 'image/jpeg');
    assert.equal(out.json.request.messages[0].content[0].type, 'image');
  });

  test('the file content decides the media type, not the declared MIME type', () => {
    const [out] = build([[PDF, 'image/png']]);
    assert.equal(out.json.request.messages[0].content[0].type, 'document');
    assert.equal(out.json.file.media_type, 'application/pdf');
  });

  test('keeps the binary for the Drive upload and drops the base64 copy from the item', () => {
    const [out] = build([[PDF, 'application/pdf']]);
    assert.deepEqual(out.binary, { file: { id: 'bin' } });
    assert.equal(out.json.file.fileBase64, undefined);
  });
});
