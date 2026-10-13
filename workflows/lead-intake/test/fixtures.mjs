// Shared test data for the Code node tests.
import { readFileSync } from 'node:fs';

export const src = (file) => new URL(`../src/${file}`, import.meta.url);

const workflow = JSON.parse(readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
export const exported = JSON.parse(workflow.nodes.find((n) => n.name === 'Settings').parameters.jsonOutput);
export const secret = 'test-secret-5f0c9a7e21';
export const settings = { ...exported, webhookSecret: secret };
