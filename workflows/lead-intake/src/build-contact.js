// @ts-check
// n8n Code node "Build contact" (mode: run once for all items).
// Builds the HubSpot upsert for one lead. Contacts are matched by email, so a lead that comes in
// twice, or one the search did not find yet, updates the same contact instead of creating a second.

/**
 * @typedef {import('./parse-qualification.js').Qualification} Qualification
 * @typedef {import('./validate-lead.js').Lead} Lead
 * @typedef {import('./prepare-qualification.js').Contact} Contact
 *
 * @typedef {object} HubSpotSettings
 * @property {string} scoreProperty contact property for fit_score, '' to skip
 * @property {string} intentProperty contact property for intent, '' to skip
 * @property {string} hotLifecycleStage stage for hot leads, one of STAGES
 */

// HubSpot's default lifecycle stages in order. A stage is only ever moved forward, so a lead
// form from an existing customer does not turn them back into a lead.
const STAGES = [
  'subscriber',
  'lead',
  'marketingqualifiedlead',
  'salesqualifiedlead',
  'opportunity',
  'customer',
  'evangelist',
];
const SALES_INTENTS = ['buy', 'info'];

/**
 * @param {string} current
 * @param {string} target
 * @returns {string} the stage to write, or '' to leave it unchanged
 */
function nextStage(current, target) {
  if (!current) return target;
  const from = STAGES.indexOf(current);
  // "other" and custom stages are not in the list; those are left to the people who set them.
  if (from === -1) return '';
  return STAGES.indexOf(target) > from ? target : '';
}

const { hubspot } = /** @type {{ hubspot: HubSpotSettings }} */ ($('Settings').first().json);
// A custom stage has no known position, so existing contacts could never be moved to it.
if (!STAGES.includes(hubspot.hotLifecycleStage))
  throw new Error(
    `hubspot.hotLifecycleStage in Settings must be one of ${STAGES.join(', ')}, not ${JSON.stringify(hubspot.hotLifecycleStage)}`,
  );

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { lead, contact, qualification, hot, needs_review } =
    /** @type {{ lead: Lead, contact: Contact | null, qualification: Qualification, hot: boolean, needs_review: boolean }} */ (
      item.json
    );

  /** @type {Record<string, string>} */
  const properties = { email: lead.email };
  // Empty form fields never overwrite what is already in HubSpot.
  for (const [prop, value] of Object.entries({
    firstname: lead.firstName,
    lastname: lead.lastName,
    company: lead.company,
    phone: lead.phone,
    website: lead.website,
  }))
    if (value) properties[prop] = value;

  if (!needs_review) {
    if (hubspot.scoreProperty) properties[hubspot.scoreProperty] = String(qualification.fit_score);
    if (hubspot.intentProperty) properties[hubspot.intentProperty] = qualification.intent;
  }
  // Leads that could not be qualified count as plain leads; support, job and partner messages
  // leave the stage alone.
  let target = '';
  if (needs_review) target = 'lead';
  else if (SALES_INTENTS.includes(qualification.intent)) target = hot ? hubspot.hotLifecycleStage : 'lead';
  const stage = target ? nextStage(contact?.lifecyclestage ?? '', target) : '';
  if (stage) properties.lifecyclestage = stage;

  return {
    json: {
      ...item.json,
      upsert: { inputs: [{ idProperty: 'email', id: lead.email, properties }] },
    },
    pairedItem: { item: i },
  };
});
