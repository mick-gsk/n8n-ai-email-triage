// @ts-check
// n8n Code node "Prepare qualification" (mode: run once for all items).
// Builds the request to Claude for each accepted lead. The lead goes into the request inside
// <lead> tags as data, and any tag that could close that block early is removed from it first.

/**
 * @typedef {import('./validate-lead.js').Lead} Lead
 *
 * @typedef {{ model: string, systemPrompt: string, businessDescription: string }} Settings
 */

const TAGS = /<\/?\s*(lead|name|email|company|website|message|business)\b[^>]*>/gi;

/** @param {unknown} s */
const stripDelimiters = (s) => String(s ?? '').replace(TAGS, ' ');

const settings = /** @type {Settings} */ ($('Settings').first().json);

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { lead } = /** @type {{ lead: Lead }} */ (item.json);

  const userContent = [
    '<lead>',
    `<name>${stripDelimiters(`${lead.firstName} ${lead.lastName}`.trim())}</name>`,
    `<email>${stripDelimiters(lead.email)}</email>`,
    `<company>${stripDelimiters(lead.company)}</company>`,
    `<website>${stripDelimiters(lead.website)}</website>`,
    `<message>${stripDelimiters(lead.message)}</message>`,
    '</lead>',
    '',
    'Qualify the lead above. Reply with the JSON object only.',
  ].join('\n');

  return {
    json: {
      lead,
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
