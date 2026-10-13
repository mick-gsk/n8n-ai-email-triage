// @ts-check
// n8n Code node "Attach folder" (mode: run once for all items).
// The input holds one item per month: existing folders as { month, folder_id }, new ones as the
// Drive API's { id, name }. Each valid file gets its month's folder and a file name that sorts by
// date: "2026-10-02 Muster GmbH RE-2026-0042.pdf".
const EXTENSIONS = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** @param {string} s */
const safe = (s) =>
  s
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** @type {Record<string, string>} */
const folders = {};
for (const { json } of $input.all()) {
  const f = /** @type {{ month?: string, folder_id?: string, id?: string, name?: string }} */ (json);
  const month = f.month ?? f.name;
  const id = f.folder_id || f.id;
  if (month && id) folders[month] = id;
}

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $('Check duplicates')
  .all()
  .filter((item) => /** @type {{ status: string }} */ (item.json).status === 'ok')
  .map((item) => {
    const r = /** @type {Record<string, string>} */ (item.json);
    const month = r.invoice_date.slice(0, 7);
    // A month without a folder here means the Drive steps returned something unexpected; stop the
    // run (the error workflow reports it) rather than upload into the wrong place.
    if (!folders[month]) throw new Error(`no Drive folder for ${month}`);
    const ext = EXTENSIONS[/** @type {keyof EXTENSIONS} */ (r.media_type)] ?? 'pdf';
    const name = safe(`${r.invoice_date} ${r.supplier_name} ${r.invoice_number}`).slice(0, 150);
    return { json: { ...r, folder_id: folders[month], drive_file_name: `${name}.${ext}` }, binary: item.binary };
  });
