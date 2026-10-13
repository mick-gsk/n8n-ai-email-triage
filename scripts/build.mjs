// Builds every workflow export in the collection: runs each workflows/*/build.mjs and
// shared/*/build.mjs, which write their workflow JSON files next to themselves.
//
//   npm run build
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../lib/n8n.mjs';

for (const group of ['shared', 'workflows']) {
  for (const dir of readdirSync(join(repoRoot, group)).sort()) {
    const script = join(repoRoot, group, dir, 'build.mjs');
    if (existsSync(script)) await import(pathToFileURL(script).href);
  }
}
