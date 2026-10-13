// Stand-ins for the OpenAI embeddings and Anthropic Messages APIs, used by test/n8n.cases.mjs.
// Responses have the shape of the real APIs, so the n8n nodes parse them as they would in
// production.

export const DIMENSIONS = 1536;

// Bag of words hashed into a fixed-size unit vector: texts that share words get similar vectors,
// so a pgvector search over these returns the passage that matches the question.
export function embed(text) {
  const v = new Float32Array(DIMENSIONS);
  const words =
    String(text)
      .toLowerCase()
      .match(/[a-zäöüß]{3,}/g) ?? [];
  for (const word of words) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[(h >>> 0) % DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export function embeddingsResponse(req) {
  const inputs = [req.body.input].flat();
  const base64 = req.body.encoding_format === 'base64';
  return {
    body: {
      object: 'list',
      model: req.body.model,
      data: inputs.map((text, index) => {
        const v = embed(text);
        return {
          object: 'embedding',
          index,
          embedding: base64 ? Buffer.from(v.buffer).toString('base64') : Array.from(v),
        };
      }),
      usage: { prompt_tokens: 10 * inputs.length, total_tokens: 10 * inputs.length },
    },
  };
}

let messageCount = 0;
const message = (content, stopReason) => ({
  body: {
    id: `msg_mock${String(++messageCount).padStart(4, '0')}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 60 },
  },
});

export const toolUse = (name, input) =>
  message(
    [{ type: 'tool_use', id: `toolu_mock${String(messageCount + 1).padStart(4, '0')}`, name, input }],
    'tool_use',
  );

export const text = (t) => message([{ type: 'text', text: t }], 'end_turn');

/** Text of the last tool_result in a Messages API request, or null if there is none yet. */
export function lastToolResult(req) {
  const blocks = req.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const result = blocks.filter((b) => b.type === 'tool_result').at(-1);
  if (!result) return null;
  return typeof result.content === 'string' ? result.content : result.content.map((c) => c.text ?? '').join('');
}
