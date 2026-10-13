import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

import { lead, qualified, settings, src } from './fixtures.mjs';

const buildContact = (item, s = settings) =>
  runCodeNode(src('build-contact.js'), { input: [item], nodes: { Settings: [s] } })[0];

const props = (item, s) => buildContact(item, s).upsert.inputs[0].properties;

test('build contact: upserts by email with form fields, score and intent', () => {
  const out = buildContact(qualified({}, { hot: true }));
  assert.deepEqual(out.upsert, {
    inputs: [
      {
        idProperty: 'email',
        id: 'jana@bakery.example',
        properties: {
          email: 'jana@bakery.example',
          firstname: 'Jana',
          lastname: 'Weber',
          company: 'Bäckerei Weber',
          phone: '+49 30 1234567',
          ai_lead_score: '86',
          ai_lead_intent: 'buy',
          lifecyclestage: 'marketingqualifiedlead',
        },
      },
    ],
  });
  assert.equal(out.lead.email, 'jana@bakery.example', 'the item is passed on');
});

test('build contact: lifecycle stage only moves forward', () => {
  const withStage = (lifecyclestage, hot) =>
    props(qualified({}, { hot, contact: { id: '1', lifecyclestage } })).lifecyclestage;
  assert.equal(withStage('', false), 'lead');
  assert.equal(withStage('subscriber', false), 'lead');
  assert.equal(withStage('lead', false), undefined);
  assert.equal(withStage('lead', true), 'marketingqualifiedlead');
  assert.equal(withStage('salesqualifiedlead', true), undefined);
  assert.equal(withStage('customer', true), undefined);
  assert.equal(withStage('other', false), undefined);
  assert.equal(withStage('some_custom_stage', true), undefined);
});

test('build contact: support, job and partner messages do not touch the stage', () => {
  for (const intent of ['support', 'job', 'partner']) {
    const p = props(qualified({ intent, fit_score: 20 }));
    assert.equal(p.lifecyclestage, undefined, intent);
    assert.equal(p.ai_lead_intent, intent);
  }
});

test('build contact: a lead that needs review is saved as a lead without score or intent', () => {
  const p = props(qualified({ fit_score: null, intent: '' }, { needs_review: true, error: 'API error: x' }));
  assert.equal(p.lifecyclestage, 'lead');
  assert.equal(p.ai_lead_score, undefined);
  assert.equal(p.ai_lead_intent, undefined);
});

test('build contact: empty form fields and unset property names are left out', () => {
  const item = qualified();
  item.lead = lead({ firstName: '', lastName: '', company: '', phone: '' });
  const p = props(item, { ...settings, hubspot: { ...settings.hubspot, scoreProperty: '', intentProperty: '' } });
  assert.deepEqual(p, { email: 'jana@bakery.example', lifecyclestage: 'lead' });
});
