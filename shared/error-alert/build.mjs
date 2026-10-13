// Builds workflow.json: a small error workflow that posts to Slack when any workflow in this
// collection fails outright. n8n assigns workflow IDs on import, so each workflow is linked to it
// by hand under Workflow settings -> Error workflow.
//
//   node shared/error-alert/build.mjs   (or npm run build for all workflows)
import { credential, link, node, reader, workflow, writeWorkflow } from '../../lib/n8n.mjs';

const read = reader(import.meta.url);

const nodes = [
  node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 300]),
  node('Format alert', 'n8n-nodes-base.code', 2, [220, 300], {
    parameters: { jsCode: read('src/format-error-alert.js') },
  }),
  node('Post to Slack', 'n8n-nodes-base.slack', 2.2, [440, 300], {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#automation-alerts' },
      text: '={{ $json.text }}',
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: credential('slackApi', 'Slack account'),
  }),
];

const connections = {
  'Error Trigger': link('Format alert'),
  'Format alert': link('Post to Slack'),
};

writeWorkflow(import.meta.url, 'workflow.json', workflow('Error alert to Slack', nodes, connections));
