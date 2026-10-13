// @ts-check
// n8n Code node "Build note" (mode: run once for all items).
// Checks that HubSpot returned the contact, then builds the note for it and the Slack text.
// Form fields and the model's summary are outside data: HTML-escaped in the note and
// Slack-escaped in the alert (no <!channel> pings, no disguised links).

/**
 * @typedef {import('./parse-qualification.js').Qualification} Qualification
 * @typedef {import('./validate-lead.js').Lead} Lead
 *
 * @typedef {object} UpsertResponse HubSpot POST /crm/v3/objects/contacts/batch/upsert response.
 * @property {string} [status]
 * @property {{ id: string, new?: boolean }[]} [results]
 * @property {{ message?: string }[]} [errors]
 *
 * @typedef {{ hubspot: { contactUrl: string } }} NoteSettings
 */

// HubSpot's association type for note -> contact.
const NOTE_TO_CONTACT = 202;

/** @param {unknown} s */
const html = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {unknown} s */
const slack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {Lead} lead */
const displayName = (lead) =>
  [`${lead.firstName} ${lead.lastName}`.trim(), lead.company].filter(Boolean).join(', ') || lead.email;

/**
 * @param {Lead} lead
 * @param {Qualification} q
 * @param {boolean} needsReview
 * @param {string} error
 */
function noteBody(lead, q, needsReview, error) {
  const lines = needsReview
    ? [`<p><strong>Website lead, not qualified automatically</strong> (${html(error)}). Please review.</p>`]
    : [
        `<p><strong>Website lead</strong>: fit ${q.fit_score}/100, intent ${html(q.intent)}</p>`,
        `<p>${html(q.summary)}</p>`,
        q.next_step ? `<p>Next step: ${html(q.next_step)}</p>` : '',
        q.budget || q.timeline
          ? `<p>Budget: ${html(q.budget || 'not stated')}. Timeline: ${html(q.timeline || 'not stated')}.</p>`
          : '',
      ];
  lines.push(`<p>Message:<br>${html(lead.message || '(empty)').replace(/\n/g, '<br>')}</p>`);
  return lines.filter(Boolean).join('');
}

/**
 * @param {Lead} lead
 * @param {Qualification} q
 * @param {string} kind
 * @param {string} error
 * @param {string} url
 */
function slackText(lead, q, kind, error, url) {
  const link = url ? `\n<${url}|Open in HubSpot>` : '';
  if (kind === 'review')
    return `:warning: *Lead needs review*: ${slack(displayName(lead))} (${slack(lead.email)})\nNot qualified automatically: ${slack(error)}${link}`;
  const details = [q.budget && `Budget: ${slack(q.budget)}`, q.timeline && `Timeline: ${slack(q.timeline)}`]
    .filter(Boolean)
    .join(' | ');
  return [
    `:fire: *Hot lead* (fit ${q.fit_score}/100): ${slack(displayName(lead))} (${slack(lead.email)})`,
    slack(q.summary),
    q.next_step && `Next step: ${slack(q.next_step)}`,
    details,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(link);
}

const { hubspot } = /** @type {NoteSettings} */ ($('Settings').first().json);
const built = $('Build contact').all();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const res = /** @type {UpsertResponse} */ (item.json);
  const { lead, qualification, hot, needs_review, error } =
    /** @type {{ lead: Lead, qualification: Qualification, hot: boolean, needs_review: boolean, error: string }} */ (
      built[i].json
    );
  const contactId = res.results?.[0]?.id;
  // A batch call can answer 200 or 207 with the failure inside the body; that must stop the run
  // so the error workflow reports it, instead of a note going to no contact.
  if (!contactId)
    throw new Error(
      `HubSpot did not return a contact for this lead: ${res.errors?.[0]?.message ?? JSON.stringify(res).slice(0, 300)}`,
    );

  const url =
    hubspot.contactUrl && !hubspot.contactUrl.includes('YOUR_PORTAL_ID') ? hubspot.contactUrl + contactId : '';
  const alert = needs_review ? 'review' : hot ? 'hot' : '';
  return {
    json: {
      contactId: String(contactId),
      created: res.results?.[0]?.new === true,
      alert,
      slackText: alert ? slackText(lead, qualification, alert, error, url) : '',
      note: {
        properties: {
          hs_timestamp: lead.receivedAt,
          hs_note_body: noteBody(lead, qualification, needs_review, error),
        },
        associations: [
          {
            to: { id: String(contactId) },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      },
    },
    pairedItem: { item: i },
  };
});
