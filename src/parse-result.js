// n8n Code node "Parse AI result" (mode: run once for all items).
// Turns the model's reply into a validated triage object. Anything malformed becomes
// category "other" with needs_review = true, so no email is ever silently dropped.
// The reply is not trusted either: the email it was generated from may contain instructions
// aimed at the model, so every field is checked or clamped here, whatever the model says.
const CATEGORIES = ['support', 'sales', 'billing', 'partnership', 'job', 'newsletter', 'spam', 'other'];
const PRIORITIES = ['high', 'normal', 'low'];
const NO_REPLY = ['newsletter', 'spam'];
const MAX_DRAFT_CHARS = 2000;
// The model has no account numbers or links of its own, so if one shows up in a draft it was
// copied from the email or made up. Either way the draft is dropped and a human takes a look.
const SUSPICIOUS_DRAFT = [/https?:\/\/|www\./i, /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}/];

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

return $input.all().map((item, i) => {
  const email = $('Prepare email').all()[i].json.email;
  const reply = item.json.content?.map((c) => c.text ?? '').join('') ?? item.json.text ?? '';
  let triage;
  try {
    const raw = extractJson(reply);
    const problems = [];
    if (!CATEGORIES.includes(raw.category)) problems.push(`category "${raw.category}"`);
    if (!PRIORITIES.includes(raw.priority)) problems.push(`priority "${raw.priority}"`);
    const category = CATEGORIES.includes(raw.category) ? raw.category : 'other';
    let needsReply = raw.needs_reply === true && !NO_REPLY.includes(category);
    if (needsReply && SUSPICIOUS_DRAFT.some((re) => re.test(String(raw.draft_reply ?? '')))) {
      problems.push('draft_reply contains a link or account number');
      needsReply = false;
    }
    triage = {
      category,
      priority: category === 'spam' ? 'low' : PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
      summary: String(raw.summary ?? '').slice(0, 300),
      needs_reply: needsReply,
      language: /^[a-z]{2}$/.test(raw.language) ? raw.language : '',
      draft_reply: needsReply ? String(raw.draft_reply ?? '').slice(0, MAX_DRAFT_CHARS) : '',
      needs_review: problems.length > 0,
      error: problems.length ? `invalid: ${problems.join(', ')}` : '',
    };
  } catch (err) {
    triage = {
      category: 'other', priority: 'normal', summary: '', needs_reply: false, language: '',
      draft_reply: '', needs_review: true, error: String(err.message ?? err),
    };
  }
  return { json: { ...email, ...triage, processedAt: new Date().toISOString() }, pairedItem: { item: i } };
});
