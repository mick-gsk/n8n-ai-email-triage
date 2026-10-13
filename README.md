# n8n AI workflows

Importable n8n workflows for small-business automation, each with an AI step that is validated
before anything is written, sent or stored. Every workflow is generated from source files and
unit-tested.

| Workflow | What it does | Services |
|---|---|---|
| [Email triage](workflows/email-triage) | Sorts new Gmail messages with Claude: labels, Slack alert for urgent mail, reply drafts, log sheet | Gmail, Anthropic, Slack, Google Sheets |
| [Error alert](shared/error-alert) | Error workflow for all of the above: posts failed runs to Slack with a link to the execution | Slack |

Each folder has its own README with setup steps, configuration, design decisions and limits.

## Using a workflow

1. In n8n: **Workflows → Import from file**, pick the folder's `workflow.json`.
2. Create the credentials listed in the folder's README and select them in the nodes. The exports
   contain no credentials.
3. Fill in the workflow's Settings node.
4. Import `shared/error-alert/workflow.json` once and select it under **Workflow settings → Error
   workflow** of each workflow.

The workflows target n8n 2.x.

## How the repository is built

```
lib/                 helpers shared by the build scripts and tests
scripts/build.mjs    runs every build.mjs below
shared/<name>/       workflows used by the others
workflows/<name>/
  build.mjs          describes the workflow in code and writes workflow.json
  src/               Code node sources and prompts, as normal files
  test/              unit tests
```

`workflow.json` files are generated; edit `build.mjs` or `src/` and run `npm run build`.

```bash
npm ci
npm test             # build all workflows, run unit and structure tests
npm run lint         # ESLint + Prettier
npm run typecheck    # tsc on the Code node sources (// @ts-check + JSDoc)
```

## License

MIT
