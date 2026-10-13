// Shared by the unit tests: Code node source paths, a Settings object and the extraction fixtures.
import { readFileSync } from 'node:fs';

export const src = (file) => new URL(`../src/${file}`, import.meta.url);
export const extractions = JSON.parse(readFileSync(new URL('./fixtures/extractions.json', import.meta.url), 'utf8'));

export const settings = {
  model: 'claude-sonnet-5-5',
  effort: 'low',
  systemPrompt: 'EXTRACT',
  outputSchema: { type: 'object' },
  dateOrder: 'DMY',
  maxPdfMB: 10,
  minImageKB: 20,
  processedLabelId: 'Label_DONE',
  reviewLabelId: 'Label_REVIEW',
};
