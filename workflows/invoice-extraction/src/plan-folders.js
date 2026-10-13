// @ts-check
// n8n Code node "Plan folders" (mode: run once for all items).
// Files are stored in one Drive folder per month of the invoice date ("2026-10") inside the folder
// set in Settings. The input is the list of folders that exist there; the output is one item per
// month this run needs, with folder_id empty where the folder still has to be created.

const existing = $input
  .all()
  .map((i) => /** @type {{ id?: string, name?: string }} */ (i.json))
  .filter((f) => f.id && f.name);
const months = new Set(
  $('Check duplicates')
    .all()
    .map((i) => /** @type {{ status: string, invoice_date: string }} */ (i.json))
    .filter((r) => r.status === 'ok')
    .map((r) => r.invoice_date.slice(0, 7)),
);

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return [...months].sort().map((month) => ({
  json: { month, folder_id: existing.find((f) => f.name === month)?.id ?? '' },
}));
