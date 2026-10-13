// @ts-check
// n8n Code node "Check message" (mode: run once for all items).
// Decides what happens to an incoming chat message before any model sees it: too long, empty or
// over the rate limit gets a fixed reply, an explicit request for a person goes straight to the
// team, everything else goes to the agent. The message is untrusted input; it reaches the agent
// inside <customer_message> tags with any such tags removed from its text.

/**
 * @typedef {{ sessionId?: string, chatInput?: string, action?: string }} ChatMessage Chat Trigger output
 * @typedef {{ session_recent?: number, all_recent?: number }} Usage "Count requests" output
 *
 * @typedef {object} Settings
 * @property {number} maxMessageChars
 * @property {number} sessionLimitPer10Min
 * @property {number} globalLimitPerMinute
 * @property {string} emptyMessage
 * @property {string} tooLongMessage
 * @property {string} rateLimitMessage
 *
 * @typedef {object} Checked
 * @property {'answer' | 'handoff' | 'reply'} route
 * @property {string} sessionId
 * @property {string} question the customer's message, cleaned
 * @property {string} prompt what the agent gets ('' unless route is answer)
 * @property {string} reason why the team is asked, or why a fixed reply is sent
 * @property {string} output fixed reply text for route reply
 */

const MAX_SESSION_ID_CHARS = 100;
// Explicit requests for a person, in English and German. Anything subtler is left to the agent,
// which hands off when it cannot answer.
const ASKS_FOR_HUMAN =
  /\b(human|real person|someone real|(talk|speak|chat) (to|with) (a |an |the )?(person|agent|someone|support|team)|live agent|mitarbeiter|echte[nr]? mensch|mensch sprechen)\b/i;

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
const usage = /** @type {Usage} */ ($input.first().json);

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
} else if (
  Number(usage.session_recent) > settings.sessionLimitPer10Min ||
  Number(usage.all_recent) > settings.globalLimitPerMinute
) {
  reply('rate limit', settings.rateLimitMessage);
} else if (ASKS_FOR_HUMAN.test(question)) {
  Object.assign(result, { route: 'handoff', reason: 'customer asked for a person' });
} else {
  result.prompt = `<customer_message>\n${stripTags(question)}\n</customer_message>`;
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return [{ json: result }];
