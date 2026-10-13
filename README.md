# n8n AI workflows

Importable n8n workflows for small-business automation, each with an AI step that is validated
before anything is written, sent or stored. Every workflow is generated from source files,
unit-tested, and run in a real n8n instance before it is committed.

| Workflow | What it does | Services |
|---|---|---|
| [Email triage](workflows/email-triage) | Sorts new Gmail messages with Claude: labels, Slack alert for urgent mail, reply drafts, log sheet | Gmail, Anthropic, Slack, Google Sheets |
| [Support chatbot](workflows/support-chatbot) | Website chat that answers from your Google Drive documents with sources, hands off to Slack when it cannot | Google Drive, OpenAI embeddings, Postgres (pgvector), Anthropic, Slack |
| [Lead intake](workflows/lead-intake) | Takes website form leads by webhook: secret check, validation, bot filter | Webhook |
| [Error alert](shared/error-alert) | Error workflow for all of the above: posts failed runs to Slack with a link to the execution | Slack |

Each folder has its own README with setup steps, configuration, design decisions and limits.

## Using a workflow

1. In n8n: **Workflows → Import from file**, pick the folder's `workflow.json` (some folders have
   more than one export, such as `ingest.json` and `chat.json`).
2. Create the credentials listed in the folder's README and select them in the nodes. The exports
   contain no credentials.
3. Fill in the workflow's Settings node.
4. Import `shared/error-alert/workflow.json` once and select it under **Workflow settings → Error
   workflow** of each workflow.

The workflows target n8n 2.x and were last run on n8n 2.43.4.

## How the repository is built

```
lib/                 helpers shared by the build scripts and tests
scripts/build.mjs    runs every build.mjs below
scripts/check-n8n.mjs  checks all exports against a real n8n instance (Docker)
shared/<name>/       workflows used by the others
workflows/<name>/
  build.mjs          describes the workflow in code and writes workflow.json
  src/               Code node sources and prompts, as normal files
  test/              unit tests and the cases run in n8n
```

`workflow.json` files are generated; edit `build.mjs` or `src/` and run `npm run build`.

```bash
npm ci
npm test             # build all workflows, run unit and structure tests
npm run lint         # ESLint + Prettier
npm run typecheck    # tsc on the Code node sources (// @ts-check + JSDoc)
npm run check:n8n    # needs Docker
```

`npm run check:n8n` uses the `n8nio/n8n` image (set `N8N_IMAGE` to pin a version) and checks three
things:

1. Every node type and version exists in that n8n release, and every top-level node parameter is
   one the node knows.
2. Every export imports with `n8n import:workflow`.
3. The cases in `workflows/*/test/n8n.cases.mjs` run with `n8n execute`. For a run, the trigger emits
   the case's test input, HTTP calls and AI credentials go to a local mock server, and nodes that
   need a real account (Gmail, Slack, Sheets, CRMs) are replaced by nodes that record what they would
   have sent. Respond to Webhook is recorded the same way, since it only runs behind a real Webhook
   trigger. Code, If, Switch, Merge, HTTP Request and AI nodes run as exported. Workflows that need
   a database get a real one: a cases file can list service containers (pgvector, for example) that
   are started next to n8n for its cases.

## License

MIT
