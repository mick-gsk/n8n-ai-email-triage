// Run of workflow.json in a real n8n instance (npm run check:n8n). Slack is replaced by a node
// that records the message it would post.
export const cases = [
  {
    name: 'a failed run is posted to Slack with a link to the execution',
    input: [
      {
        execution: {
          id: 231,
          url: 'https://n8n.example.com/workflow/7/executions/231',
          error: { message: 'Label_SUPPORT is not a valid label', node: { name: 'Add Gmail label' } },
          lastNodeExecuted: 'Add Gmail label',
          mode: 'trigger',
        },
        workflow: { id: '7', name: 'AI Email Triage (Gmail + Claude)' },
      },
    ],
    check(run, assert) {
      const [post] = run.out('Post to Slack');
      assert.equal(post.sent._node, 'n8n-nodes-base.slack');
      assert.match(post.sent.text, /failed in \*Add Gmail label\*/);
      assert.match(post.sent.text, /executions\/231\|Open execution>$/);
    },
  },
];
