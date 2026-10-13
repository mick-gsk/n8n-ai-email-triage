// Stand-in for the OpenAI embeddings API, used by test/n8n.cases.mjs.
// Responses have the shape of the real API, so the n8n nodes parse them as they would in
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
