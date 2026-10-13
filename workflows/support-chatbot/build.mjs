// Builds the two exports of the support chatbot from the sources in src/:
//   ingest.json  Google Drive folder -> chunks with embeddings in Postgres (pgvector)
//   chat.json    website chat -> Claude agent that searches those chunks, hands off to Slack
//
//   node workflows/support-chatbot/build.mjs   (or npm run build for all workflows)
import { credential, ifCondition, link, node, reader, slackSafe, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID';
const TABLE = 'support_chunks';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'claude-haiku-5-5';

const drive = credential('googleDriveOAuth2Api', 'Google Drive account');
const postgres = credential('postgres', 'Postgres (support bot)');
const openAi = credential('openAiApi', 'OpenAI account');

const ai = (type, ...targets) => ({ [type]: [targets.map((n) => ({ node: n, type, index: 0 }))] });

// --- ingest.json -------------------------------------------------------------------------------

const folder = { __rl: true, mode: 'id', value: FOLDER_ID };

// SQL that deletes chunks. Each run tags its chunks with the execution id, so old chunks are only
// removed once the new ones are stored; a file never has no chunks while it is being updated.
// Two runs can store the same file at the same time (Drive Trigger during the nightly sync), so
// the cleanup keeps the newest run's chunks, not its own: whichever run cleans up last, one set
// remains. Execution ids increase, so the newest run is the one with the highest id.
const removeOldChunks = `WITH chunks AS (
  SELECT id, CASE WHEN metadata ->> 'ingest_run' ~ '^[0-9]+$' THEN (metadata ->> 'ingest_run')::bigint END AS run
  FROM ${TABLE}
  WHERE metadata ->> 'file_id' = $1
), newest AS (
  SELECT GREATEST($2::bigint, max(run)) AS run FROM chunks
), removed AS (
  DELETE FROM ${TABLE} t
  USING chunks c, newest n
  WHERE t.id = c.id AND (c.run IS NULL OR c.run < n.run)
  RETURNING 1
)
SELECT count(*)::int AS removed_chunks FROM removed`;

// An empty ID list (empty folder) deletes every chunk.
const forgetRemovedFiles = `WITH removed AS (
  DELETE FROM ${TABLE}
  WHERE NOT (metadata ->> 'file_id' IN (SELECT jsonb_array_elements_text($1::jsonb)))
  RETURNING 1
)
SELECT count(*)::int AS removed_chunks FROM removed`;

const ingestNodes = [
  node('Drive Trigger', 'n8n-nodes-base.googleDriveTrigger', 1, [0, 200], {
    parameters: {
      pollTimes: { item: [{ mode: 'everyX', value: 10, unit: 'minutes' }] },
      triggerOn: 'specificFolder',
      folderToWatch: folder,
      // Drive sets modifiedTime on upload too, so this also picks up new files.
      event: 'fileUpdated',
      options: {},
    },
    credentials: drive,
  }),

  node('Nightly sync', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 460], {
    parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 3 }] } },
  }),

  node('Sync now', 'n8n-nodes-base.manualTrigger', 1, [0, 620]),

  node('List folder', 'n8n-nodes-base.googleDrive', 3, [220, 540], {
    parameters: {
      resource: 'fileFolder',
      operation: 'search',
      searchMethod: 'name',
      queryString: '',
      returnAll: true,
      filter: { folderId: folder, whatToSearch: 'files', includeTrashed: false },
      // All fields, because the field list offers no `size`, which Select files needs.
      options: { fields: ['*'] },
    },
    credentials: drive,
    // An empty folder still runs "Forget removed files", which then deletes every chunk.
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  }),

  node('Forget removed files', 'n8n-nodes-base.postgres', 2.7, [460, 660], {
    parameters: {
      operation: 'executeQuery',
      query: forgetRemovedFiles,
      options: {
        queryReplacement: "={{ [ JSON.stringify($('List folder').all().map((i) => i.json.id).filter(Boolean)) ] }}",
      },
    },
    credentials: postgres,
    executeOnce: true,
  }),

  node('Select files', 'n8n-nodes-base.code', 2, [460, 300], {
    parameters: { jsCode: read('src/select-files.js') },
  }),

  node('Download file', 'n8n-nodes-base.googleDrive', 3, [680, 300], {
    parameters: {
      operation: 'download',
      fileId: { __rl: true, mode: 'id', value: '={{ $json.file_id }}' },
      options: { googleFileConversion: { conversion: { docsToFormat: 'text/markdown' } } },
    },
    credentials: drive,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  }),

  // One file per pass through Store chunks and Remove old chunks, so the loader's metadata
  // expressions and the cleanup always refer to that one file.
  node('Loop over files', 'n8n-nodes-base.splitInBatches', 3, [900, 300], {
    parameters: { batchSize: 1, options: {} },
  }),

  node('Store chunks', '@n8n/n8n-nodes-langchain.vectorStorePGVector', 1.3, [1120, 300], {
    parameters: { mode: 'insert', tableName: TABLE, embeddingBatchSize: 100, options: {} },
    credentials: postgres,
    // Keeps the run going to "Remove old chunks" when a file turned out empty.
    alwaysOutputData: true,
  }),

  node('Embeddings', '@n8n/n8n-nodes-langchain.embeddingsOpenAi', 1.2, [1040, 520], {
    parameters: { model: EMBEDDING_MODEL, options: {} },
    credentials: openAi,
  }),

  node('Document loader', '@n8n/n8n-nodes-langchain.documentDefaultDataLoader', 1.1, [1200, 520], {
    parameters: {
      dataType: 'binary',
      binaryMode: 'specificField',
      binaryDataKey: 'data',
      loader: 'auto',
      textSplittingMode: 'custom',
      options: {
        metadata: {
          metadataValues: [
            { name: 'file_id', value: "={{ $('Loop over files').item.json.file_id }}" },
            { name: 'file_name', value: "={{ $('Loop over files').item.json.file_name }}" },
            { name: 'source_url', value: "={{ $('Loop over files').item.json.source_url }}" },
            { name: 'ingest_run', value: '={{ $execution.id }}' },
          ],
        },
      },
    },
  }),

  node('Text splitter', '@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter', 1, [1280, 700], {
    parameters: { chunkSize: 1000, chunkOverlap: 150, options: {} },
  }),

  node('Remove old chunks', 'n8n-nodes-base.postgres', 2.7, [1360, 300], {
    parameters: {
      operation: 'executeQuery',
      query: removeOldChunks,
      options: {
        queryReplacement: "={{ [ $('Loop over files').item.json.file_id, String($execution.id) ] }}",
      },
    },
    credentials: postgres,
    executeOnce: true,
  }),
];

const ingestConnections = {
  'Drive Trigger': link('Select files'),
  'Nightly sync': link('List folder'),
  'Sync now': link('List folder'),
  'List folder': link(['Select files', 'Forget removed files']),
  'Select files': link('Download file'),
  'Download file': link('Loop over files'),
  // Output 0 ("done") ends the run, output 1 ("loop") gets the next file.
  'Loop over files': link([], 'Store chunks'),
  'Store chunks': link('Remove old chunks'),
  'Remove old chunks': link('Loop over files'),
  Embeddings: ai('ai_embedding', 'Store chunks'),
  'Document loader': ai('ai_document', 'Store chunks'),
  'Text splitter': ai('ai_textSplitter', 'Document loader'),
};

writeWorkflow(
  import.meta.url,
  'ingest.json',
  workflow('Support chatbot: ingest Drive documents', ingestNodes, ingestConnections),
);

// --- chat.json ---------------------------------------------------------------------------------

const settings = {
  maxMessageChars: 1000,
  sessionLimitPer10Min: 20,
  globalLimitPerMinute: 30,
  slackChannel: '#support-handoff',
  emptyMessage: 'Please type your question.',
  tooLongMessage: 'That message is too long for this chat. Please shorten it and send it again.',
  rateLimitMessage: 'You have sent many messages in a short time. Please wait a few minutes and try again.',
  handoffMessage:
    'I could not find an answer to that in our documentation, so I have passed your question on to our team. ' +
    'You can also reach us at support@example.com.',
};

const countRequests = `INSERT INTO support_chat_requests (session_id) VALUES ($1);
DELETE FROM support_chat_requests WHERE created_at < now() - interval '1 day';
SELECT
  (SELECT count(*) FROM support_chat_requests WHERE session_id = $1 AND created_at > now() - interval '10 minutes')::int AS session_recent,
  (SELECT count(*) FROM support_chat_requests WHERE created_at > now() - interval '1 minute')::int AS all_recent`;

const routeRule = (route) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: `route-${route}`,
        leftValue: '={{ $json.route }}',
        rightValue: route,
        operator: { type: 'string', operation: 'equals' },
      },
    ],
    combinator: 'and',
  },
  renameOutput: true,
  outputKey: route,
});

const chatNodes = [
  node('Chat Trigger', '@n8n/n8n-nodes-langchain.chatTrigger', 1.5, [0, 300], {
    parameters: {
      public: true,
      mode: 'webhook',
      authentication: 'none',
      options: {
        allowedOrigins: 'https://www.example.com',
        loadPreviousSession: 'notSupported',
        responseMode: 'lastNode',
      },
    },
  }),

  node('Settings', 'n8n-nodes-base.set', 3.4, [220, 300], {
    parameters: { mode: 'raw', jsonOutput: JSON.stringify(settings, null, 2), options: {} },
  }),

  node('Count requests', 'n8n-nodes-base.postgres', 2.7, [440, 300], {
    parameters: {
      operation: 'executeQuery',
      query: countRequests,
      options: {
        queryReplacement: "={{ [ String($('Chat Trigger').first().json.sessionId ?? '').slice(0, 100) ] }}",
        queryBatching: 'independently',
      },
    },
    credentials: postgres,
  }),

  node('Check message', 'n8n-nodes-base.code', 2, [660, 300], {
    parameters: { jsCode: read('src/check-message.js') },
  }),

  node('Route', 'n8n-nodes-base.switch', 3.2, [880, 300], {
    parameters: { rules: { values: ['answer', 'handoff', 'reply'].map(routeRule) }, options: {} },
  }),

  node('Support agent', '@n8n/n8n-nodes-langchain.agent', 3.1, [1120, 140], {
    parameters: {
      promptType: 'define',
      text: '={{ $json.prompt }}',
      options: {
        systemMessage: read('src/system-prompt.md').trim(),
        maxIterations: 5,
        returnIntermediateSteps: true,
      },
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    // A failed model call goes to "Check answer" as { error } and becomes a handoff.
    onError: 'continueErrorOutput',
  }),

  node('Claude', '@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.6, [1000, 380], {
    parameters: {
      model: { __rl: true, mode: 'id', value: CHAT_MODEL },
      options: { maxTokensToSample: 1024, thinkingMode: 'disabled' },
    },
    credentials: credential('anthropicApi', 'Anthropic account'),
  }),

  node('Chat memory', '@n8n/n8n-nodes-langchain.memoryPostgresChat', 1.4, [1140, 380], {
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: '={{ $json.sessionId }}',
      tableName: 'support_chat_histories',
      contextWindowLength: 6,
    },
    credentials: postgres,
  }),

  node('search_documents', '@n8n/n8n-nodes-langchain.vectorStorePGVector', 1.3, [1280, 380], {
    parameters: {
      mode: 'retrieve-as-tool',
      toolDescription:
        "Searches the company's support documents. Input: a short search query in the customer's language. " +
        'Returns matching passages with their file_name.',
      tableName: TABLE,
      topK: 4,
      includeDocumentMetadata: true,
      options: {},
    },
    credentials: postgres,
  }),

  node('Query embeddings', '@n8n/n8n-nodes-langchain.embeddingsOpenAi', 1.2, [1280, 560], {
    parameters: { model: EMBEDDING_MODEL, options: {} },
    credentials: openAi,
  }),

  node('Check answer', 'n8n-nodes-base.code', 2, [1400, 140], {
    parameters: { jsCode: read('src/check-answer.js') },
  }),

  node('Needs the team?', 'n8n-nodes-base.if', 2.2, [1620, 140], {
    parameters: ifCondition('needs-team', '={{ $json.route }}', 'handoff', { type: 'string', operation: 'equals' }),
  }),

  node('Notify team on Slack', 'n8n-nodes-base.slack', 2.2, [1840, 300], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: "={{ $('Settings').first().json.slackChannel }}" },
      text: `=Support chat needs a person: ${slackSafe('reason')}\nSession: ${slackSafe('sessionId')}\nQuestion: ${slackSafe('question')}`,
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: credential('slackApi', 'Slack account'),
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  }),

  // The Chat Trigger returns the last node's output to the browser, so the reply nodes keep
  // only the text; session id, reason and sources metadata stay server-side.
  node('Handoff reply', 'n8n-nodes-base.set', 3.4, [2060, 300], {
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'output', name: 'output', type: 'string', value: "={{ $('Settings').first().json.handoffMessage }}" },
        ],
      },
      options: {},
    },
  }),

  node('Reply', 'n8n-nodes-base.set', 3.4, [1840, 40], {
    parameters: {
      mode: 'manual',
      assignments: { assignments: [{ id: 'output', name: 'output', type: 'string', value: '={{ $json.output }}' }] },
      options: {},
    },
  }),
];

const chatConnections = {
  'Chat Trigger': link('Settings'),
  Settings: link('Count requests'),
  'Count requests': link('Check message'),
  'Check message': link('Route'),
  Route: link('Support agent', 'Notify team on Slack', 'Reply'),
  'Support agent': link('Check answer', 'Check answer'),
  Claude: ai('ai_languageModel', 'Support agent'),
  'Chat memory': ai('ai_memory', 'Support agent'),
  search_documents: ai('ai_tool', 'Support agent'),
  'Query embeddings': ai('ai_embedding', 'search_documents'),
  'Check answer': link('Needs the team?'),
  'Needs the team?': link('Notify team on Slack', 'Reply'),
  'Notify team on Slack': link('Handoff reply'),
};

writeWorkflow(import.meta.url, 'chat.json', workflow('Support chatbot: chat', chatNodes, chatConnections));
