// Shared by the unit tests: Code node source paths and a Settings object.
export const src = (file) => new URL(`../src/${file}`, import.meta.url);

export const settings = {
  maxPdfMB: 10,
  minImageKB: 20,
  processedLabelId: 'Label_DONE',
  reviewLabelId: 'Label_REVIEW',
};
