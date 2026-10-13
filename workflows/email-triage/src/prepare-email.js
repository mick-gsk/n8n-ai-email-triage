// @ts-check
// n8n Code node "Prepare email" (mode: run once for all items).
// Normalises the Gmail trigger output into a compact object and builds the LLM request body.
// The email is untrusted input: it goes into the request inside <email> tags as data, and any
// tag that could close that block early is removed from it first.
const MAX_CHARS = 6000;
const MAX_HEADER_CHARS = 300;

/**
 * @typedef {object} GmailMessage Gmail Trigger output with "Simplify" off (fields used here).
 * @property {string} id
 * @property {string} threadId
 * @property {string[]} [labelIds]
 * @property {{ value?: { address?: string }[], text?: string }} [from]
 * @property {string} [subject]
 * @property {string} [text]
 * @property {string} [html]
 * @property {string} [textPlain] simplified output
 * @property {string} [snippet] simplified output
 * @property {string} [From] simplified output
 * @property {string} [Subject] simplified output
 *
 * @typedef {{ model: string, systemPrompt: string, doneLabel?: string }} Settings
 */

/** @param {unknown} s */
const stripDelimiters = (s) => String(s).replace(/<\/?\s*(email|from|subject|body)\b[^>]*>/gi, ' ');

/** @param {string} html */
const htmlToText = (html) => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');

/**
 * Sorting one email does not need thinking, and thinking tokens count against max_tokens, so a
 * long email could run out before the JSON. Models differ in how thinking is turned off: Haiku
 * accepts "disabled", Sonnet 5.5 only "between_tools", and Opus 5.5 or Fable reject both with a
 * 400. For those the field is left out and max_tokens is raised to leave room for thinking.
 * @param {string} model
 * @returns {{ thinking?: { type: string }, max_tokens: number }}
 */
function thinkingOptions(model) {
  if (model.startsWith('claude-haiku')) return { thinking: { type: 'disabled' }, max_tokens: 700 };
  if (model.startsWith('claude-sonnet-5-5')) return { thinking: { type: 'between_tools' }, max_tokens: 700 };
  return { max_tokens: 4000 };
}

const settings = /** @type {Settings} */ ($('Settings').first().json);
// In production the trigger only returns mail received since the last poll. A manual
// "Execute workflow" run fetches the newest unread email again, though, so mail that was fully
// processed before (it carries doneLabel) is skipped instead of getting a second draft, alert and
// log row. A category label alone does not count: a run can fail after labelling, and a re-run
// then has to do the rest.
const messages = $('Gmail Trigger')
  .all()
  .map((item) => /** @type {GmailMessage} */ (item.json))
  .filter((m) => !settings.doneLabel || !(m.labelIds ?? []).includes(settings.doneLabel));

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return messages.map((m) => {
  // Kept whole for the draft, Slack and the log; only the copy in the prompt is shortened.
  const from = m.from?.value?.[0]?.address ?? m.from?.text ?? m.From ?? '';
  const subject = m.subject ?? m.Subject ?? '';
  let body = m.text ?? m.textPlain ?? m.snippet ?? '';
  if (!body && m.html) body = htmlToText(m.html);
  body = body.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

  const email = { id: m.id, threadId: m.threadId, from, subject, body };
  const userContent = [
    '<email>',
    `<from>${stripDelimiters(from.slice(0, MAX_HEADER_CHARS))}</from>`,
    `<subject>${stripDelimiters(subject.slice(0, MAX_HEADER_CHARS))}</subject>`,
    `<body>${stripDelimiters(body)}</body>`,
    '</email>',
    '',
    'Classify the email above. Reply with the JSON object only.',
  ].join('\n');

  return {
    json: {
      email,
      request: {
        model: settings.model,
        ...thinkingOptions(settings.model),
        system: settings.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      },
    },
  };
});
