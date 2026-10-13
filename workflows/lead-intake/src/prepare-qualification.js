// @ts-check
// n8n Code node "Prepare qualification" (mode: run once for all items).
// Combines the validated lead with the HubSpot search result and builds the request to Claude.
// The lead goes into the request inside <lead> tags as data, and any tag that could close that
// block early is removed from it first.

/**
 * @typedef {import('./validate-lead.js').Lead} Lead
 *
 * @typedef {object} SearchResponse HubSpot POST /crm/v3/objects/contacts/search response.
 * @property {number} [total]
 * @property {{ id: string, properties?: Record<string, string | null> }[]} [results]
 *
 * @typedef {{ id: string, lifecyclestage: string, firstname: string, lastname: string, company: string }} Contact
 *
 * @typedef {{ model: string, systemPrompt: string, businessDescription: string }} Settings
 */

const TAGS = /<\/?\s*(lead|crm|name|email|company|website|message|business)\b[^>]*>/gi;

/** @param {unknown} s */
const stripDelimiters = (s) => String(s ?? '').replace(TAGS, ' ');

/**
 * @param {SearchResponse} res
 * @returns {Contact | null}
 */
function existingContact(res) {
  const hit = res.results?.[0];
  if (!hit?.id) return null;
  const p = hit.properties ?? {};
  return {
    id: String(hit.id),
    // Only a property name goes on to the prompt and the stage comparison.
    lifecyclestage: /^[a-z0-9_]{1,40}$/.test(p.lifecyclestage ?? '') ? String(p.lifecyclestage) : '',
    firstname: String(p.firstname ?? ''),
    lastname: String(p.lastname ?? ''),
    company: String(p.company ?? ''),
  };
}

const settings = /** @type {Settings} */ ($('Settings').first().json);
const accepted = $('Accepted?').all();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { lead } = /** @type {{ lead: Lead }} */ (accepted[i].json);
  const contact = existingContact(/** @type {SearchResponse} */ (item.json));

  const crm = contact
    ? `Existing contact. Lifecycle stage: ${contact.lifecyclestage || 'not set'}.`
    : 'New contact, not in the CRM yet.';
  const userContent = [
    '<lead>',
    `<name>${stripDelimiters(`${lead.firstName} ${lead.lastName}`.trim())}</name>`,
    `<email>${stripDelimiters(lead.email)}</email>`,
    `<company>${stripDelimiters(lead.company)}</company>`,
    `<website>${stripDelimiters(lead.website)}</website>`,
    `<message>${stripDelimiters(lead.message)}</message>`,
    '</lead>',
    `<crm>${crm}</crm>`,
    '',
    'Qualify the lead above. Reply with the JSON object only.',
  ].join('\n');

  return {
    json: {
      lead,
      contact,
      request: {
        model: settings.model,
        max_tokens: 500,
        // Haiku 5.5 thinks by default and thinking tokens count against max_tokens; scoring one
        // form does not need it.
        thinking: { type: 'disabled' },
        system: `${settings.systemPrompt}\n\nAbout the business:\n${settings.businessDescription}`,
        messages: [{ role: 'user', content: userContent }],
      },
    },
    pairedItem: { item: i },
  };
});
