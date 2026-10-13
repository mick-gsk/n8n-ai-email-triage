// n8n Code node "Prepare email" (mode: run once for all items).
// Normalises the Gmail trigger output into a compact object and builds the LLM request body.
// The email is untrusted input: it goes into the request inside <email> tags as data, and any
// tag that could close that block early is removed from it first.
const MAX_CHARS = 6000;

const stripDelimiters = (s) => String(s).replace(/<\/?\s*(email|from|subject|body)\b[^>]*>/gi, ' ');

const settings = $('Settings').first().json;

return $('Gmail Trigger').all().map((item) => {
  const m = item.json;
  const from = m.from?.value?.[0]?.address ?? m.from?.text ?? m.From ?? '';
  const subject = m.subject ?? m.Subject ?? '';
  let body = m.text ?? m.textPlain ?? m.snippet ?? '';
  if (!body && m.html) body = String(m.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  body = String(body).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

  const email = { id: m.id, threadId: m.threadId, from, subject, body };
  const userContent = [
    '<email>',
    `<from>${stripDelimiters(from)}</from>`,
    `<subject>${stripDelimiters(subject)}</subject>`,
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
        max_tokens: 700,
        system: settings.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      },
    },
  };
});
