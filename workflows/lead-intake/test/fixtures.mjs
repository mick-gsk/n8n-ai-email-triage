// Shared test data for the Code node tests.
import { readFileSync } from 'node:fs';

export const src = (file) => new URL(`../src/${file}`, import.meta.url);

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
export const exported = JSON.parse(workflow.nodes.find((n) => n.name === 'Settings').parameters.jsonOutput);
export const secret = 'test-secret-5f0c9a7e21';
export const settings = {
  ...exported,
  webhookSecret: secret,
  businessDescription: 'Web design agency for small businesses. Websites and shops from 5,000 to 30,000 EUR.',
};

/** Lead as Validate lead produces it, for the later nodes. */
export const lead = (extra = {}) => ({
  email: 'jana@bakery.example',
  firstName: 'Jana',
  lastName: 'Weber',
  company: 'Bäckerei Weber',
  phone: '+49 30 1234567',
  website: '',
  message: 'We need a new website for 3 shops. Budget 12,000 EUR, live by March.',
  truncated: false,
  receivedAt: '2026-10-13T09:00:00.000Z',
  ...extra,
});

/** A valid qualification as Claude should return it. */
export const valid = {
  fit_score: 86,
  intent: 'buy',
  budget: '12,000 EUR',
  timeline: 'by March',
  summary: 'Bakery with 3 shops wants a new website.',
  next_step: 'Call and send a quote.',
};

/** Parse qualification output. */
export const qualified = (q = {}, extra = {}) => ({
  lead: lead(),
  contact: null,
  qualification: { ...valid, ...q },
  hot: false,
  needs_review: false,
  error: '',
  ...extra,
});
