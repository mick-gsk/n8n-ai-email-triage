// @ts-check
// n8n Code node "Check message" (mode: run once for all items).
// Decides what happens to an incoming chat message before any model sees it: too long or empty
// gets a fixed reply, everything else goes to the agent. The message is untrusted input; it
// reaches the agent inside <customer_message> tags with any such tags removed from its text.

/**
 * @typedef {{ sessionId?: string, chatInput?: string, action?: string }} ChatMessage Chat Trigger output
 *
 * @typedef {object} Settings
 * @property {number} maxMessageChars
 * @property {string} emptyMessage
 * @property {string} tooLongMessage
 *
 * @typedef {object} Checked
 * @property {'answer' | 'reply'} route
 * @property {string} sessionId
 * @property {string} question the customer's message, cleaned
 * @property {string} prompt what the agent gets ('' unless route is answer)
 * @property {string} reason why a fixed reply is sent
 * @property {string} output fixed reply text for route reply
 */

const MAX_SESSION_ID_CHARS = 100;

/** @param {unknown} s */
const clean = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .trim();

/** @param {string} s */
const stripTags = (s) => s.replace(/<\/?\s*customer_message\b[^>]*>/gi, ' ');

const settings = /** @type {Settings} */ ($('Settings').first().json);
const chat = /** @type {ChatMessage} */ ($('Chat Trigger').first().json);

const sessionId = clean(chat.sessionId).slice(0, MAX_SESSION_ID_CHARS);
const question = clean(chat.chatInput);

/** @type {Checked} */
const result = { route: 'answer', sessionId, question, prompt: '', reason: '', output: '' };

/** @param {string} reason @param {string} output */
const reply = (reason, output) => Object.assign(result, { route: 'reply', reason, output });

if (!sessionId || !question) {
  reply('empty message', settings.emptyMessage);
} else if (question.length > settings.maxMessageChars) {
  // The cut-off copy keeps the log readable; the customer is asked to shorten the message.
  result.question = question.slice(0, settings.maxMessageChars);
  reply(`message longer than ${settings.maxMessageChars} characters`, settings.tooLongMessage);
} else {
  result.prompt = `<customer_message>\n${stripTags(question)}\n</customer_message>`;
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return [{ json: result }];
