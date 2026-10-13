import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

import { lead, qualified, settings, src } from './fixtures.mjs';

const noteSettings = {
  ...settings,
  hubspot: { ...settings.hubspot, contactUrl: 'https://app.hubspot.com/contacts/123/record/0-1/' },
};

const buildNote = (response, item, s = noteSettings) =>
  runCodeNode(src('build-note.js'), { input: [response], nodes: { Settings: [s], 'Build contact': [item] } })[0];

const upserted = { status: 'COMPLETE', results: [{ id: '101', new: true }] };

test('build note: note for the returned contact, Slack text for a hot lead', () => {
  const out = buildNote(upserted, qualified({}, { hot: true }));
  assert.equal(out.contactId, '101');
  assert.equal(out.created, true);
  assert.equal(out.alert, 'hot');
  assert.deepEqual(out.note.associations, [
    { to: { id: '101' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
  ]);
  assert.equal(out.note.properties.hs_timestamp, '2026-10-13T09:00:00.000Z');
  assert.match(out.note.properties.hs_note_body, /^<p><strong>Website lead<\/strong>: fit 86\/100, intent buy<\/p>/);
  assert.match(out.note.properties.hs_note_body, /Budget: 12,000 EUR\. Timeline: by March\./);
  assert.equal(
    out.slackText,
    [
      ':fire: *Hot lead* (fit 86/100): Jana Weber, Bäckerei Weber (jana@bakery.example)',
      'Bakery with 3 shops wants a new website.',
      'Next step: Call and send a quote.',
      'Budget: 12,000 EUR | Timeline: by March',
      '<https://app.hubspot.com/contacts/123/record/0-1/101|Open in HubSpot>',
    ].join('\n'),
  );
});

test('build note: no Slack text for an ordinary lead', () => {
  const out = buildNote({ results: [{ id: '55', new: false }] }, qualified({ intent: 'info', fit_score: 40 }));
  assert.equal(out.alert, '');
  assert.equal(out.slackText, '');
  assert.equal(out.created, false);
});

test('build note: a lead that needs review says why, in the note and on Slack', () => {
  const out = buildNote(
    upserted,
    qualified({ fit_score: null, intent: '', summary: '' }, { needs_review: true, error: 'API error: overloaded' }),
  );
  assert.equal(out.alert, 'review');
  assert.match(out.note.properties.hs_note_body, /not qualified automatically<\/strong> \(API error: overloaded\)/);
  assert.match(
    out.slackText,
    /^:warning: \*Lead needs review\*: Jana Weber, Bäckerei Weber \(jana@bakery\.example\)\nNot qualified automatically: API error: overloaded\n</,
  );
});

test('build note: form and model text is escaped in the note and on Slack', () => {
  const item = qualified({ summary: 'Wants <!channel> & <https://evil.example|a link>' }, { hot: true });
  item.lead = lead({
    firstName: '<img src=x onerror=alert(1)>',
    message: 'Line 1\n<a href="https://evil.example">click</a>',
  });
  const out = buildNote(upserted, item);
  assert.doesNotMatch(out.note.properties.hs_note_body, /<img|<a /);
  assert.match(
    out.note.properties.hs_note_body,
    /Line 1<br>&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt;/,
  );
  assert.doesNotMatch(out.slackText, /<!channel>|<https:\/\/evil|<img/);
  assert.match(out.slackText, /Wants &lt;!channel&gt; &amp; &lt;https:\/\/evil\.example\|a link&gt;/);
});

test('build note: no HubSpot link while the portal ID is a placeholder', () => {
  const out = buildNote(upserted, qualified({}, { hot: true }), settings);
  assert.doesNotMatch(out.slackText, /Open in HubSpot/);
});

test('build note: a response without a contact stops the run', () => {
  assert.throws(
    () =>
      buildNote(
        { status: 'COMPLETE', results: [], errors: [{ message: 'Property values were not valid' }] },
        qualified(),
      ),
    /HubSpot did not return a contact for this lead: Property values were not valid/,
  );
  assert.throws(() => buildNote({}, qualified()), /HubSpot did not return a contact/);
});
