// The parts of the n8n Code node runtime that src/*.js use, for `npm run typecheck`.
// Not part of the workflow export.

interface N8nItem<T = unknown> {
  json: T;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number };
}

interface N8nNodeOutput<T = unknown> {
  all(): N8nItem<T>[];
  first(): N8nItem<T>;
}

/** Items coming into this node. */
declare const $input: N8nNodeOutput;

/** Output of another node in the same execution, by node name. */
declare function $(nodeName: string): N8nNodeOutput;

/** Node's Buffer, which the Code node provides; only what src/*.js use. */
declare const Buffer: {
  from(data: string, encoding: 'base64' | 'latin1' | 'utf8'): Uint8Array & { toString(encoding?: string): string };
};

/** The WHATWG TextDecoder, which the Code node provides. */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
