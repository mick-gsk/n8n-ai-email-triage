import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

const src = (file) => new URL(`../src/${file}`, import.meta.url);

const driveFile = (over = {}) => ({
  id: '1abc',
  name: 'Refund policy',
  mimeType: 'application/vnd.google-apps.document',
  webViewLink: 'https://docs.google.com/document/d/1abc/edit',
  ...over,
});
const select = (files) => runCodeNode(src('select-files.js'), { input: files });

test('select files: keeps readable files with the fields stored on each chunk', () => {
  assert.deepEqual(select([driveFile()]), [
    {
      file_id: '1abc',
      file_name: 'Refund policy',
      mime_type: 'application/vnd.google-apps.document',
      source_url: 'https://docs.google.com/document/d/1abc/edit',
    },
  ]);
});

test('select files: skips unsupported, trashed, oversized and repeated files', () => {
  const kept = select([
    driveFile({ id: 'img', mimeType: 'image/png' }),
    driveFile({ id: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet' }),
    driveFile({ id: 'bin', trashed: true }),
    driveFile({ id: 'big', mimeType: 'application/pdf', size: String(50 * 1024 * 1024) }),
    driveFile({ id: 'pdf', mimeType: 'application/pdf', size: '20480' }),
    driveFile({ id: 'pdf', mimeType: 'application/pdf', size: '20480' }),
    driveFile({ id: '' }),
  ]);
  assert.deepEqual(
    kept.map((f) => f.file_id),
    ['pdf'],
  );
});

test('select files: cleans file names and drops links that are not Google Drive', () => {
  const [f] = select([
    driveFile({ name: 'Prices\n<script>  2026 ' + 'x'.repeat(300), webViewLink: 'https://evil.example/' }),
  ]);
  assert.match(f.file_name, /^Prices script 2026 x+$/);
  assert.equal(f.file_name.length, 200);
  assert.equal(f.source_url, '');
  assert.equal(select([driveFile({ name: '  ' })])[0].file_name, '1abc', 'falls back to the file id');
});
