// @ts-check
// n8n Code node "Check answer" (mode: run once for all items).
// Validates the agent's reply before the customer sees it. The reply is only passed on when it
// cites at least one document the search actually returned; the source links are added here from
// the stored metadata, never taken from the model. Everything else, including a HANDOFF reply, a
// failed model call and an answer with a link in it, goes to the team instead.
const MAX_ANSWER_CHARS = 1500;
// Replies without a source are only allowed when every sentence is small talk from this list
// (greeting, thanks, goodbye, offer to help), in English or German. Anything else, however short,
// could be an invented fact ("Shipping is free.") and goes to the team.
const MAX_UNSOURCED_CHARS = 200;
const SMALL_TALK = [
  /^(hi|hello|hey|good (morning|afternoon|evening)|hallo|guten (morgen|tag|abend)|moin|servus)( there)?$/,
  /^((thank you|thanks)( (so|very) much)?( for (reaching out|your message|contacting us))?|you'?re welcome|my pleasure|glad (i could|to) help|danke( schön| sehr)?|gern geschehen|gerne)$/,
  /^(goodbye|bye|have a (nice|great|good) day|auf wiedersehen|tschüss|einen schönen tag( noch)?)$/,
  /^(how can i help( you)?( today)?|what can i do for you( today)?|is there anything else i can help( you)? with|can i help with anything else|wie kann ich (dir|ihnen) helfen|was kann ich für (dich|sie) tun|kann ich (dir|ihnen) sonst noch helfen)$/,
];
const SOURCE_URL = /^https:\/\/(docs|drive)\.google\.com\/[^\s()]*$/;

/**
 * @typedef {object} AgentResult AI Agent output (main or error output)
 * @property {string} [output]
 * @property {{ observation?: unknown }[]} [intermediateSteps]
 * @property {string | { message?: string }} [error]
 *
 * @typedef {{ sessionId: string, question: string }} Checked "Check message" output (fields used here)
 *
 * @typedef {object} Answer
 * @property {'answer' | 'handoff'} route
 * @property {string} sessionId
 * @property {string} question
 * @property {string} reason why the team is asked, '' for answers
 * @property {string} output reply text ('' for handoffs; the handoff text comes from Settings)
 * @property {string[]} sources cited file names
 */

/**
 * @param {unknown} v
 * @returns {any} the parsed value, v itself if it is not a string, undefined if it is not JSON
 */
const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

/** @param {unknown} value */
const asList = (value) => {
  const v = parseJson(value);
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
};

/**
 * File names and links of every chunk in the tool results. Only the known layers of the PGVector
 * tool output are read: the observation (a JSON string of `[{ response: [...] }]`), the text
 * blocks in `response` (`{ type: 'text', text }`), and the document in each block's text
 * (`{ pageContent, metadata }`). Metadata comes only from that document; pageContent is document
 * text and is never parsed, so a document cannot pose as another file.
 * @param {unknown[]} observations
 */
function collectSources(observations) {
  /** @type {Map<string, string>} file_name -> source_url */
  const found = new Map();
  for (const entry of observations.flatMap(asList)) {
    const blocks = entry && typeof entry === 'object' && 'response' in entry ? asList(entry.response) : [entry];
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || block.type !== 'text') continue;
      const doc = parseJson(block.text);
      if (!doc || typeof doc !== 'object' || typeof doc.pageContent !== 'string') continue;
      const meta = doc.metadata;
      if (meta && typeof meta === 'object' && typeof meta.file_name === 'string')
        found.set(meta.file_name, typeof meta.source_url === 'string' ? meta.source_url : '');
    }
  }
  return found;
}

/**
 * The retrieved file names listed in a "Sources:" line. File names can contain commas, so the line
 * is not simply split: runs of comma-separated parts are joined back and kept when they equal a
 * retrieved name, the longest run first. Parts that match nothing are ignored.
 * @param {string} line
 * @param {Map<string, string>} retrieved
 */
function citedNames(line, retrieved) {
  const parts = line.split(',');
  /** @type {string[]} */
  const cited = [];
  for (let i = 0; i < parts.length;) {
    let next = i + 1;
    for (let j = parts.length; j > i; j--) {
      const name = parts.slice(i, j).join(',').trim().replace(/^`|`$/g, '');
      if (retrieved.has(name)) {
        if (!cited.includes(name)) cited.push(name);
        next = j;
        break;
      }
    }
    i = next;
  }
  return cited;
}

/** @param {string} body */
const isSmallTalk = (body) =>
  body.length <= MAX_UNSOURCED_CHARS &&
  body
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[.!?,;:]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .every((s) => SMALL_TALK.some((re) => re.test(s)));

/** @param {string} s */
const escapeMarkdown = (s) => s.replace(/([\\[\]()*_`])/g, '\\$1');

/**
 * @param {AgentResult} res
 * @returns {{ route: 'answer' | 'handoff', reason: string, output: string, sources: string[] }}
 */
function check(res) {
  /** @param {string} reason */
  const handoff = (reason) => ({ route: /** @type {const} */ ('handoff'), reason, output: '', sources: [] });

  if (res.error) {
    const message = typeof res.error === 'string' ? res.error : (res.error.message ?? JSON.stringify(res.error));
    return handoff(`agent error: ${message.slice(0, 200)}`);
  }
  const reply = String(res.output ?? '').trim();
  if (!reply) return handoff('empty answer');
  const asked = reply.match(/^\s*HANDOFF:\s*(.*)$/im);
  if (asked) return handoff(asked[1].trim().slice(0, 200) || 'agent could not answer');

  const retrieved = collectSources(res.intermediateSteps?.map((s) => s.observation) ?? []);
  const sourcesLine = reply.match(/\n\s*\**sources?\**:\**\s*(.+?)\s*$/i);
  const body = (sourcesLine ? reply.slice(0, sourcesLine.index) : reply).trim();
  if (/https?:\/\/|www\./i.test(body)) return handoff('answer contained a link');

  if (!sourcesLine) {
    if (isSmallTalk(body)) return { route: 'answer', reason: '', output: body, sources: [] };
    return handoff('answer without a source');
  }
  const cited = citedNames(sourcesLine[1], retrieved);
  if (!cited.length) return handoff('answer cites no document the search returned');

  const links = cited.map((name) => {
    const url = retrieved.get(name) ?? '';
    return SOURCE_URL.test(url) ? `[${escapeMarkdown(name)}](${url})` : escapeMarkdown(name);
  });
  const text = body.length > MAX_ANSWER_CHARS ? `${body.slice(0, MAX_ANSWER_CHARS).trimEnd()}...` : body;
  return { route: 'answer', reason: '', output: `${text}\n\nSources: ${links.join(', ')}`, sources: cited };
}

const message = /** @type {Checked} */ ($('Check message').first().json);
const res = /** @type {AgentResult} */ ($input.first().json);

/** @type {Answer} */
const answer = { sessionId: message.sessionId, question: message.question, ...check(res) };

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return [{ json: answer }];
