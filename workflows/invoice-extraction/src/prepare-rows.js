// @ts-check
// n8n Code node "Prepare rows" (mode: run once for all items).
// The Drive upload replaces each item with the uploaded file's metadata, in the same order. This
// puts the invoice back together with a link to its file, in the shape of the Invoices sheet.

const files = $('Attach folder').all();

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((upload, i) => {
  const r = /** @type {Record<string, any>} */ (files[i].json);
  const { id } = /** @type {{ id?: string }} */ (upload.json);
  return {
    json: {
      processed_at: r.processed_at,
      document_type: r.document_type,
      supplier_name: r.supplier_name,
      supplier_vat_id: r.supplier_vat_id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      payment_terms_days: r.payment_terms_days,
      currency: r.currency,
      net_amount: r.net_amount,
      vat_amount: r.vat_amount,
      gross_amount: r.gross_amount,
      vat_rates: r.vat_lines
        .map((/** @type {{ rate: number | null, vat: number | null }} */ l) => `${l.rate ?? '?'}%: ${l.vat ?? '?'}`)
        .join('; '),
      iban: r.iban,
      line_items: r.line_items.length ? JSON.stringify(r.line_items) : '',
      file_name: r.file_name,
      file_link: id ? `https://drive.google.com/file/d/${id}/view` : '',
      email_from: r.email_from,
      email_subject: r.email_subject,
      message_id: r.message_id,
    },
    pairedItem: { item: i },
  };
});
