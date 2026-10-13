// @ts-check
// n8n Code node "Parse AI result" (mode: run once for all items).
// Turns the model's reply into a validated triage object. Anything malformed becomes
// category "other" with needs_review = true, so no email is ever silently dropped.
// The reply is not trusted either: the email it was generated from may contain instructions
// aimed at the model, so every field is checked or clamped here, whatever the model says.
const CATEGORIES = ['support', 'sales', 'billing', 'partnership', 'job', 'newsletter', 'spam', 'other'];
const PRIORITIES = ['high', 'normal', 'low'];
const NO_REPLY = ['newsletter', 'spam'];
const MAX_DRAFT_CHARS = 2000;
// The model has no links or bank details of its own, so if one shows up in a draft it was
// copied from the email or made up. Either way the draft is dropped and a human takes a look.
// Links: any scheme (https://, ftp://), www., or a domain followed by a path (evil.example/pay).
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//i;
// IBAN-shaped: country code, check digits, 11 to 30 more characters, in any case and with
// spaces, dashes or dots between them. Real IBANs are mostly digits with at most four letters
// in a row (bank codes like WEST), which keeps ordinary sentences from matching.
const IBAN_CANDIDATE = /\b[a-z]{2}\d{2}(?:[ .-]?[a-z0-9]){11,30}/gi;

/** @param {string} candidate */
function looksLikeIban(candidate) {
  // The match can run into the next word ("... 00 Best regards"), so trailing letters are cut.
  const bban = candidate
    .replace(/[ .-]/g, '')
    .slice(4)
    .replace(/[a-z]+$/i, '');
  return bban.length >= 11 && !/[a-z]{5}/i.test(bban) && (bban.match(/\d/g) ?? []).length >= 8;
}

/** @param {string} text */
function isSuspiciousDraft(text) {
  return LINK.test(text) || [...text.matchAll(IBAN_CANDIDATE)].some((m) => looksLikeIban(m[0]));
}

/**
 * @typedef {object} ClaudeResponse Ask Claude output: a Messages API response, or { error } after failed retries.
 * @property {{ type: string, text?: string }[]} [content]
 * @property {string} [stop_reason]
 * @property {string} [text]
 * @property {string | { message?: string }} [error]
 *
 * @typedef {{ id: string, threadId: string, from: string, subject: string, body: string }} Email
 *
 * @typedef {object} Triage
 * @property {string} category one of CATEGORIES
 * @property {string} priority one of PRIORITIES
 * @property {string} summary
 * @property {boolean} needs_reply
 * @property {string} language ISO 639-1 code or ''
 * @property {string} draft_reply '' unless needs_reply
 * @property {boolean} needs_review
 * @property {string} error why needs_review is set, or ''
 */

/** @param {string} text */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** @param {NonNullable<ClaudeResponse['error']>} error */
function apiErrorMessage(error) {
  return `API error: ${typeof error === 'string' ? error : (error.message ?? JSON.stringify(error))}`;
}

/**
 * @param {ClaudeResponse} res
 * @returns {Triage}
 */
function triage(res) {
  // Ask Claude continues on error, so a failed request (after its retries) arrives here as
  // { error } and ends up in the Review label with the reason in the log.
  if (res.error) throw new Error(apiErrorMessage(res.error));
  if (res.stop_reason === 'max_tokens') throw new Error('model reply cut off at max_tokens');
  if (res.stop_reason === 'refusal') throw new Error('model declined to answer');
  const reply = res.content?.map((c) => c.text ?? '').join('') ?? res.text ?? '';
  const raw = extractJson(reply);

  const problems = [];
  if (!CATEGORIES.includes(raw.category)) problems.push(`category "${raw.category}"`);
  if (!PRIORITIES.includes(raw.priority)) problems.push(`priority "${raw.priority}"`);
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'other';

  let needsReply = raw.needs_reply === true && !NO_REPLY.includes(category);
  if (needsReply && isSuspiciousDraft(String(raw.draft_reply ?? ''))) {
    problems.push('draft_reply contains a link or IBAN');
    needsReply = false;
  }

  return {
    category,
    priority: category === 'spam' ? 'low' : PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    summary: String(raw.summary ?? '').slice(0, 300),
    needs_reply: needsReply,
    language: /^[a-z]{2}$/.test(raw.language) ? raw.language : '',
    draft_reply: needsReply ? String(raw.draft_reply ?? '').slice(0, MAX_DRAFT_CHARS) : '',
    needs_review: problems.length > 0,
    error: problems.length ? `invalid: ${problems.join(', ')}` : '',
  };
}

const prepared = $('Prepare email').all();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { email } = /** @type {{ email: Email }} */ (prepared[i].json);
  /** @type {Triage} */
  let result;
  try {
    result = triage(/** @type {ClaudeResponse} */ (item.json));
  } catch (err) {
    result = {
      category: 'other',
      priority: 'normal',
      summary: '',
      needs_reply: false,
      language: '',
      draft_reply: '',
      needs_review: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { json: { ...email, ...result, processedAt: new Date().toISOString() }, pairedItem: { item: i } };
});
