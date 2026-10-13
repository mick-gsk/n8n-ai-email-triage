// n8n Code node "Prepare email" (mode: run once for all items).
// Normalises the Gmail trigger output into a compact object and builds the LLM request body.
const MAX_CHARS = 6000;

const settings = $('Settings').first().json;

return $('Gmail Trigger').all().map((item) => {
  const m = item.json;
  const from = m.from?.value?.[0]?.address ?? m.from?.text ?? m.From ?? '';
  const subject = m.subject ?? m.Subject ?? '';
  let body = m.text ?? m.textPlain ?? m.snippet ?? '';
  if (!body && m.html) body = String(m.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  body = String(body).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

  const email = { id: m.id, threadId: m.threadId, from, subject, body };
  const userContent = `From: ${from}\nSubject: ${subject}\n\n${body}`;

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
