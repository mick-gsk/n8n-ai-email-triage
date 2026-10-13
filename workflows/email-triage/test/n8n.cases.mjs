// Runs of workflow.json in a real n8n instance (npm run check:n8n). Gmail, Slack and Sheets are
// replaced by nodes that record what they would send; Claude is answered by a local mock.
import { readFileSync } from 'node:fs';

const emails = JSON.parse(readFileSync(new URL('./fixtures/emails.json', import.meta.url), 'utf8'));

const claudeSays = (result) => ({ body: { content: [{ type: 'text', text: JSON.stringify(result) }] } });

const urgent = {
  category: 'support',
  priority: 'high',
  summary: 'Checkout returns error 500 for all customers since 8am.',
  needs_reply: true,
  draft_reply: 'Hi Anna, thanks for letting us know. We are looking into the checkout error now.',
};
const newsletter = { category: 'newsletter', priority: 'low', summary: 'Monthly product update.', needs_reply: false };

export const cases = [
  {
    name: 'urgent support email is labelled, alerted, drafted and logged',
    input: emails.slice(0, 2),
    http: {
      'POST api.anthropic.com/v1/messages': (req) =>
        claudeSays(req.body.messages[0].content.includes('error 500') ? urgent : newsletter),
    },
    check(run, assert) {
      const claude = run.requests.filter((r) => r.host === 'api.anthropic.com');
      assert.equal(claude.length, 2);
      assert.equal(claude[0].headers['x-api-key'], 'test-key');
      assert.equal(claude[0].headers['anthropic-version'], '2023-06-01');

      const labels = run.out('Add Gmail label');
      assert.deepEqual(
        labels.map((l) => l.sent.labelIds),
        [['Label_SUPPORT'], ['Label_NEWSLETTER']],
      );
      const [alert] = run.out('Alert on Slack');
      assert.equal(run.out('Alert on Slack').length, 1, 'only the urgent email goes to Slack');
      assert.match(alert.sent.text, /\*support\* from anna@customer\.example/);
      const drafts = run.out('Create reply draft');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].sent.subject, 'Re: Checkout broken since this morning');
      assert.equal(drafts[0].sent.options.threadId, '18f0a1');
      assert.equal(run.out('Log to Google Sheets').length, 2);
      const done = run.out('Mark as triaged');
      assert.deepEqual(
        done.map((d) => [d.sent.messageId, d.sent.labelIds]),
        [
          ['18f0a1', ['Label_TRIAGED']],
          ['18f0a2', ['Label_TRIAGED']],
        ],
      );
    },
  },
  {
    name: 'API errors still end up labelled for review',
    input: emails.slice(0, 1),
    http: {
      'POST api.anthropic.com/v1/messages': () => ({ status: 400, body: { error: { message: 'bad request' } } }),
    },
    check(run, assert) {
      const [parsed] = run.out('Parse AI result');
      assert.equal(parsed.category, 'other');
      assert.equal(parsed.needs_review, true);
      assert.match(parsed.error, /API error/);
      assert.deepEqual(run.out('Add Gmail label')[0].sent.labelIds, ['Label_REVIEW']);
      assert.equal(run.out('Create reply draft').length, 0);
    },
  },
];
