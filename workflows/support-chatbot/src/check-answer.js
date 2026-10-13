// @ts-check
// n8n Code node "Check answer" (mode: run once for all items).
// Validates the agent's reply before the customer sees it. The reply is only passed on when it
// cites at least one document the search actually returned; the source links are added here from
// the stored metadata, never taken from the model. Everything else, including a HANDOFF reply, a
// failed model call and an answer with a link in it, goes to the team instead.
const MAX_ANSWER_CHARS = 1500;
// Short replies without a source are allowed for greetings and thanks, but not if they contain
// numbers, which is where invented prices and deadlines would show up.
const MAX_UNSOURCED_CHARS = 200;
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
 * File names and links of every chunk in the tool results. The vector store tool returns
 * JSON-encoded documents nested in JSON strings, so strings are parsed wherever they look like JSON.
 * @param {unknown} value
 * @param {Map<string, string>} found file_name -> source_url
 */
function collectSources(value, found = new Map()) {
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        collectSources(JSON.parse(s), found);
      } catch {
        // not JSON, ignore
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectSources(v, found);
  } else if (value && typeof value === 'object') {
    const meta = /** @type {{ metadata?: { file_name?: unknown, source_url?: unknown } }} */ (value).metadata;
    if (meta && typeof meta.file_name === 'string')
      found.set(meta.file_name, typeof meta.source_url === 'string' ? meta.source_url : '');
    for (const v of Object.values(value)) collectSources(v, found);
  }
  return found;
}

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
    if (body.length <= MAX_UNSOURCED_CHARS && !/\d/.test(body))
      return { route: 'answer', reason: '', output: body, sources: [] };
    return handoff('answer without a source');
  }
  const cited = [...new Set(sourcesLine[1].split(',').map((s) => s.trim().replace(/^`|`$/g, '')))].filter((name) =>
    retrieved.has(name),
  );
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
