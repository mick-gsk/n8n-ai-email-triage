// @ts-check
// n8n Code node "Format alert" in error-workflow.json (mode: run once for all items).
// Turns the Error Trigger output into one Slack message. Error messages can quote email
// content (a subject in a failed Gmail call, for example), so they are escaped like the
// fields in the main workflow's alert.
const MAX_MESSAGE_CHARS = 500;

/**
 * @typedef {{ message?: string, description?: string, node?: { name?: string } }} N8nError
 *
 * @typedef {object} ErrorTriggerOutput
 * @property {{ id?: string, name?: string }} workflow
 * @property {{ id?: string | number, url?: string, lastNodeExecuted?: string, mode?: string, error?: N8nError }} [execution]
 *   set when a node after the trigger failed
 * @property {{ mode?: string, error?: N8nError }} [trigger] set when the trigger itself failed
 */

/** @param {unknown} s */
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((item) => {
  const { workflow, execution, trigger } = /** @type {ErrorTriggerOutput} */ (item.json);
  const error = execution?.error ?? trigger?.error ?? {};
  const node = error.node?.name ?? execution?.lastNodeExecuted ?? (trigger ? 'trigger' : 'unknown node');
  const message = String(error.message ?? 'no error message').slice(0, MAX_MESSAGE_CHARS);

  const lines = [
    `:x: *${slackEscape(workflow.name ?? 'Workflow')}* failed in *${slackEscape(node)}*`,
    slackEscape(message),
  ];
  if (error.description) lines.push(`_${slackEscape(String(error.description).slice(0, MAX_MESSAGE_CHARS))}_`);
  // Manual test runs have no stored execution to link to.
  if (execution?.url) lines.push(`<${execution.url}|Open execution>`);

  return { json: { text: lines.join('\n'), workflowId: workflow.id ?? '', executionId: String(execution?.id ?? '') } };
});
