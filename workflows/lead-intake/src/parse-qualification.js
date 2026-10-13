// @ts-check
// n8n Code node "Parse qualification" (mode: run once for all items).
// Turns Claude's reply into a validated qualification. A failed call or a malformed reply sets
// needs_review: the lead is still saved to HubSpot, without score or intent, and a human is told.
// The reply is not trusted either: the form it was generated from may contain instructions aimed
// at the model, so every field is checked or clamped here, whatever the model says.

/**
 * @typedef {import('./validate-lead.js').Lead} Lead
 * @typedef {import('./prepare-qualification.js').Contact} Contact
 *
 * @typedef {object} ClaudeResponse Ask Claude output: a Messages API response, or { error } after failed retries.
 * @property {{ type: string, text?: string }[]} [content]
 * @property {string} [stop_reason]
 * @property {string | { message?: string }} [error]
 *
 * @typedef {object} Qualification
 * @property {number | null} fit_score 0-100, null when needs_review
 * @property {string} intent one of INTENTS, '' when needs_review
 * @property {string} budget as stated in the form, or ''
 * @property {string} timeline as stated in the form, or ''
 * @property {string} summary
 * @property {string} next_step
 */

const INTENTS = ['buy', 'info', 'support', 'spam', 'job', 'partner'];
const MAX = { budget: 100, timeline: 100, summary: 300, next_step: 200 };

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
 * @param {unknown} value
 * @param {number} max
 */
function text(value, max) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/**
 * True if every number in the model's value also appears in what the visitor wrote, so a budget
 * the model made up or "corrected" is dropped instead of stored.
 * @param {string} value
 * @param {string} source
 */
function numbersFrom(value, source) {
  const digits = (/** @type {string} */ s) => (s.match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''));
  const known = new Set(digits(source.replace(/(\d)[.,'\s](?=\d{3}\b)/g, '$1')));
  return digits(value.replace(/(\d)[.,'\s](?=\d{3}\b)/g, '$1')).every((n) => known.has(n));
}

/**
 * @param {ClaudeResponse} res
 * @param {Lead} lead
 * @returns {{ qualification: Qualification, problems: string[] }}
 */
function qualify(res, lead) {
  // Ask Claude continues on error, so a failed request (after its retries) arrives here as { error }.
  if (res.error) throw new Error(apiErrorMessage(res.error));
  if (res.stop_reason === 'max_tokens') throw new Error('model reply cut off at max_tokens');
  if (res.stop_reason === 'refusal') throw new Error('model declined to answer');
  const raw = extractJson(res.content?.map((c) => c.text ?? '').join('') ?? '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('model reply is not a JSON object');

  const problems = [];
  const scoreOk = Number.isInteger(raw.fit_score) && raw.fit_score >= 0 && raw.fit_score <= 100;
  if (!scoreOk) problems.push(`fit_score ${JSON.stringify(raw.fit_score)}`);
  const intentOk = INTENTS.includes(raw.intent);
  if (!intentOk) problems.push(`intent ${JSON.stringify(raw.intent)}`);
  const summary = text(raw.summary, MAX.summary);
  if (!summary) problems.push('summary missing');

  const source = `${lead.message} ${lead.company}`;
  const budget = text(raw.budget, MAX.budget);
  const timeline = text(raw.timeline, MAX.timeline);
  const valid = problems.length === 0;
  return {
    problems,
    qualification: {
      fit_score: valid ? (raw.intent === 'spam' ? 0 : raw.fit_score) : null,
      intent: valid ? raw.intent : '',
      budget: budget && numbersFrom(budget, source) ? budget : '',
      timeline: timeline && numbersFrom(timeline, source) ? timeline : '',
      summary,
      next_step: text(raw.next_step, MAX.next_step),
    },
  };
}

const settings = /** @type {{ hotScore: number }} */ ($('Settings').first().json);
const prepared = $('Prepare qualification').all();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { lead, contact } = /** @type {{ lead: Lead, contact: Contact | null }} */ (prepared[i].json);
  /** @type {Qualification} */
  let qualification;
  let error = '';
  try {
    const result = qualify(/** @type {ClaudeResponse} */ (item.json), lead);
    qualification = result.qualification;
    if (result.problems.length) error = `invalid: ${result.problems.join(', ')}`;
  } catch (err) {
    qualification = { fit_score: null, intent: '', budget: '', timeline: '', summary: '', next_step: '' };
    error = err instanceof Error ? err.message : String(err);
  }
  const needsReview = error !== '';
  const hot = !needsReview && qualification.intent === 'buy' && Number(qualification.fit_score) >= settings.hotScore;
  return {
    json: { lead, contact, qualification, hot, needs_review: needsReview, error },
    pairedItem: { item: i },
  };
});
