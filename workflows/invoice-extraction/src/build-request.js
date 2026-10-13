// @ts-check
// n8n Code node "Build request" (mode: run once for all items).
// Builds one Anthropic Messages API request per file: the file as a document (PDF) or image block,
// the system prompt, and the JSON schema the reply must follow. Claude reads scanned documents and
// photos directly, so there is no separate OCR step.
const MAX_TOKENS = 16000;

// The declared MIME type of an attachment is set by the sender's mail program and is sometimes
// wrong; the first bytes say what the file is.
const SIGNATURES = [
  ['JVBERi0', 'application/pdf'],
  ['/9j/', 'image/jpeg'],
  ['iVBORw0KGgo', 'image/png'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
];

/**
 * @typedef {{ model: string, effort: string, systemPrompt: string, outputSchema: object }} Settings
 * @typedef {{ fileBase64: string, media_type: string } & Record<string, unknown>} FileItem
 */

/** @param {string} base64 */
const sniff = (base64) => SIGNATURES.find(([prefix]) => base64.startsWith(prefix))?.[1];

const settings = /** @type {Settings} */ ($('Settings').first().json);

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item, i) => {
  const { fileBase64, ...file } = /** @type {FileItem} */ (item.json);
  const media_type = sniff(fileBase64) ?? file.media_type;
  const source = { type: 'base64', media_type, data: fileBase64 };
  const block = media_type === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
  return {
    json: {
      file: { ...file, media_type },
      request: {
        model: settings.model,
        max_tokens: MAX_TOKENS,
        // Thinking stays at the model's default (adaptive); effort keeps it short for a task that
        // is reading, not reasoning. The totals are checked in code afterwards anyway.
        output_config: { effort: settings.effort, format: { type: 'json_schema', schema: settings.outputSchema } },
        system: settings.systemPrompt,
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: 'Extract the data of the attached document.' }],
          },
        ],
      },
    },
    binary: item.binary,
    pairedItem: { item: i },
  };
});
