// @ts-check
// n8n Code node "Validate lead" (mode: run once for all items).
// Checks the shared secret and turns the raw form post into a clean lead, or into the HTTP
// response that rejects it. Everything in the request comes from the internet: field values are
// stripped of HTML and control characters, cut to fixed lengths, and only known fields are kept.

/**
 * @typedef {object} WebhookRequest Webhook node output.
 * @property {Record<string, string | undefined>} [headers] header names in lower case
 * @property {Record<string, unknown>} [query]
 * @property {unknown} [body] parsed JSON or form fields
 *
 * @typedef {'email' | 'name' | 'firstName' | 'lastName' | 'company' | 'phone' | 'website' | 'message'} Field
 *
 * @typedef {object} Settings
 * @property {string} webhookSecret
 * @property {string} businessDescription checked here so a placeholder never reaches Claude
 * @property {string} secretHeader
 * @property {string} [secretQueryParam] '' disables the query parameter
 * @property {string} honeypotField
 * @property {Record<Field, string[]>} fields accepted form field names per lead field
 * @property {Field[]} requiredFields
 *
 * @typedef {object} Lead
 * @property {string} email lower case
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} company
 * @property {string} phone
 * @property {string} website
 * @property {string} message
 * @property {boolean} truncated a field was longer than its limit
 * @property {string} receivedAt ISO timestamp
 *
 * @typedef {'accepted' | 'bot' | 'invalid' | 'unauthorized' | 'misconfigured'} Status
 */

/** @type {Record<Field, number>} */
const MAX_CHARS = {
  email: 254,
  name: 200,
  firstName: 100,
  lastName: 100,
  company: 200,
  phone: 40,
  website: 200,
  message: 5000,
};
const MIN_SECRET_CHARS = 16;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PHONE = /^(?=.*\d)[0-9+()./\s-]{5,40}$/;
const WEBSITE = /^(https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d+)?(\/\S*)?$/i;

/**
 * Compares in time that depends only on the expected secret's length, so response times do not
 * reveal how many leading characters of a guess were right.
 * @param {string} given
 * @param {string} expected
 */
function sameSecret(given, expected) {
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i % (given.length || 1)) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {unknown} value
 * @param {boolean} multiline
 */
function clean(value, multiline) {
  const text = String(value)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ');
  if (!multiline) return text.replace(/\s+/g, ' ').trim();
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Status} status
 * @param {number} httpStatus
 * @param {Record<string, unknown>} body
 * @param {Partial<{ lead: Lead, errors: string[] }>} [extra]
 */
const outcome = (status, httpStatus, body, extra = {}) => ({
  status,
  response: { status: httpStatus, body },
  errors: extra.errors ?? [],
  lead: extra.lead ?? null,
});

/** @param {string[]} errors */
const invalid = (errors) => outcome('invalid', 400, { ok: false, errors }, { errors });

/**
 * @param {WebhookRequest} req
 * @param {Settings} settings
 */
function validate(req, settings) {
  const secret = String(settings.webhookSecret ?? '');
  const business = String(settings.businessDescription ?? '').trim();
  const config = [];
  if (secret.length < MIN_SECRET_CHARS || secret.startsWith('REPLACE'))
    config.push(`webhookSecret in Settings must be set to a random string of at least ${MIN_SECRET_CHARS} characters`);
  if (!business || business.startsWith('REPLACE'))
    config.push('businessDescription in Settings must describe the business');
  if (config.length)
    return outcome('misconfigured', 500, { ok: false, error: 'server not configured' }, { errors: config });
  const header = req.headers?.[settings.secretHeader.toLowerCase()];
  const query = settings.secretQueryParam ? req.query?.[settings.secretQueryParam] : undefined;
  const given = typeof header === 'string' ? header : typeof query === 'string' ? query : '';
  if (!sameSecret(given, secret)) return outcome('unauthorized', 401, { ok: false, error: 'unauthorized' });

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return invalid(['body must be a JSON object or form fields']);

  // Form tools differ in field names and capitalisation, so fields are matched case-insensitively
  // against the names configured in Settings.
  /** @type {Map<string, unknown>} */
  const byKey = new Map(Object.entries(body).map(([k, v]) => [k.trim().toLowerCase(), v]));

  // Bots fill every field; people never see the hidden one. They get the same answer as a real
  // submission so they cannot tell the difference.
  const trap = byKey.get(settings.honeypotField.toLowerCase());
  if (trap !== undefined && trap !== null && String(trap).trim() !== '') return outcome('bot', 202, { ok: true });

  const errors = [];
  let truncated = false;
  /** @type {Record<Field, string>} */
  const raw = { email: '', name: '', firstName: '', lastName: '', company: '', phone: '', website: '', message: '' };
  for (const field of /** @type {Field[]} */ (Object.keys(raw))) {
    const key = (settings.fields[field] ?? []).map((k) => k.toLowerCase()).find((k) => byKey.has(k));
    if (key === undefined) continue;
    const value = byKey.get(key);
    if (value === null || value === undefined) continue;
    if (!['string', 'number'].includes(typeof value)) {
      errors.push(`${field} must be text`);
      continue;
    }
    const text = clean(value, field === 'message');
    if (text.length > MAX_CHARS[field]) truncated = true;
    raw[field] = text.slice(0, MAX_CHARS[field]).trim();
  }

  for (const field of settings.requiredFields)
    if (!raw[field] && !errors.includes(`${field} must be text`)) errors.push(`${field} is required`);
  const email = raw.email.toLowerCase();
  if (email && (!EMAIL.test(email) || /^\.|\.\.|\.@/.test(email))) errors.push('email is not a valid address');
  if (raw.phone && !PHONE.test(raw.phone)) errors.push('phone must be digits, optionally with spaces and + ( ) . / -');
  if (raw.website && !WEBSITE.test(raw.website)) errors.push('website is not a valid domain or URL');
  if (errors.length) return invalid(errors);

  let { firstName, lastName } = raw;
  if (!firstName && !lastName && raw.name) {
    const [first, ...rest] = raw.name.split(' ');
    firstName = first.slice(0, MAX_CHARS.firstName);
    lastName = rest.join(' ').slice(0, MAX_CHARS.lastName);
  }

  /** @type {Lead} */
  const lead = {
    email,
    firstName,
    lastName,
    company: raw.company,
    phone: raw.phone,
    website: raw.website,
    message: raw.message,
    truncated,
    receivedAt: new Date().toISOString(),
  };
  return outcome('accepted', 202, { ok: true }, { lead });
}

const settings = /** @type {Settings} */ ($('Settings').first().json);

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $('Lead webhook')
  .all()
  .map((item, i) => ({ json: validate(/** @type {WebhookRequest} */ (item.json), settings), pairedItem: { item: i } }));
