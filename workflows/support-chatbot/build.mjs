// Builds ingest.json from the sources in src/: Google Drive folder -> chunks with embeddings in
// Postgres (pgvector), for the support chatbot to search.
//
//   node workflows/support-chatbot/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

// Replace these placeholders after import (see README, "Setup").
const FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID';
const TABLE = 'support_chunks';
const EMBEDDING_MODEL = 'text-embedding-3-small';

const drive = credential('googleDriveOAuth2Api', 'Google Drive account');
const postgres = credential('postgres', 'Postgres (support bot)');
const openAi = credential('openAiApi', 'OpenAI account');

const ai = (type, ...targets) => ({ [type]: [targets.map((n) => ({ node: n, type, index: 0 }))] });

const folder = { __rl: true, mode: 'id', value: FOLDER_ID };

// SQL that deletes chunks. Each run tags its chunks with the execution id, so old chunks are only
// removed once the new ones are stored; a file never has no chunks while it is being updated.
const removeOldChunks = `WITH removed AS (
  DELETE FROM ${TABLE}
  WHERE metadata ->> 'file_id' IN (SELECT jsonb_array_elements_text($1::jsonb))
    AND metadata ->> 'ingest_run' IS DISTINCT FROM $2
  RETURNING 1
)
SELECT count(*)::int AS removed_chunks FROM removed`;

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
      options: { fields: ['id', 'name', 'mimeType', 'webViewLink', 'trashed'] },
    },
    credentials: drive,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  }),

  node('Forget removed files', 'n8n-nodes-base.postgres', 2.7, [460, 660], {
    parameters: {
      operation: 'executeQuery',
      query: forgetRemovedFiles,
      options: { queryReplacement: "={{ [ JSON.stringify($('List folder').all().map((i) => i.json.id)) ] }}" },
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

  node('Store chunks', '@n8n/n8n-nodes-langchain.vectorStorePGVector', 1.3, [900, 300], {
    parameters: { mode: 'insert', tableName: TABLE, embeddingBatchSize: 100, options: {} },
    credentials: postgres,
    // Keeps the run going to "Remove old chunks" when a file turned out empty.
    alwaysOutputData: true,
  }),

  node('Embeddings', '@n8n/n8n-nodes-langchain.embeddingsOpenAi', 1.2, [820, 520], {
    parameters: { model: EMBEDDING_MODEL, options: {} },
    credentials: openAi,
  }),

  node('Document loader', '@n8n/n8n-nodes-langchain.documentDefaultDataLoader', 1.1, [980, 520], {
    parameters: {
      dataType: 'binary',
      binaryMode: 'specificField',
      binaryDataKey: 'data',
      loader: 'auto',
      textSplittingMode: 'custom',
      options: {
        metadata: {
          metadataValues: [
            { name: 'file_id', value: "={{ $('Select files').item.json.file_id }}" },
            { name: 'file_name', value: "={{ $('Select files').item.json.file_name }}" },
            { name: 'source_url', value: "={{ $('Select files').item.json.source_url }}" },
            { name: 'ingest_run', value: '={{ $execution.id }}' },
          ],
        },
      },
    },
  }),

  node('Text splitter', '@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter', 1, [1060, 700], {
    parameters: { chunkSize: 1000, chunkOverlap: 150, options: {} },
  }),

  node('Remove old chunks', 'n8n-nodes-base.postgres', 2.7, [1140, 300], {
    parameters: {
      operation: 'executeQuery',
      query: removeOldChunks,
      options: {
        queryReplacement:
          "={{ [ JSON.stringify($('Select files').all().map((i) => i.json.file_id)), String($execution.id) ] }}",
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
  'Download file': link('Store chunks'),
  'Store chunks': link('Remove old chunks'),
  Embeddings: ai('ai_embedding', 'Store chunks'),
  'Document loader': ai('ai_document', 'Store chunks'),
  'Text splitter': ai('ai_textSplitter', 'Document loader'),
};

writeWorkflow(
  import.meta.url,
  'ingest.json',
  workflow('Support chatbot: ingest Drive documents', ingestNodes, ingestConnections),
);
