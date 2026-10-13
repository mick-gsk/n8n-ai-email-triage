// @ts-check
// n8n Code node "Prepare rows" (mode: run once for all items).
// Puts each valid invoice into the shape of the Invoices sheet. When the files are filed in Drive,
// the input is the upload result (the file's metadata, one item per invoice, in the same order)
// and the row gets a link to the file; otherwise the input is the invoices themselves.

const records = $('Check duplicates')
  .all()
  .filter((item) => /** @type {{ status: string }} */ (item.json).status === 'ok');
const uploaded = Boolean(/** @type {{ driveFolderId?: string }} */ ($('Settings').first().json).driveFolderId);

/** @param {number | null} n */
const money = (n) => (n === null ? '?' : n.toFixed(2));

// @ts-expect-error n8n runs Code node sources as a function body, so the top-level return is valid there.
return $input.all().map((input, i) => {
  const r = /** @type {Record<string, any>} */ (records[i].json);
  const { id } = uploaded ? /** @type {{ id?: string }} */ (input.json) : {};
  return {
    json: {
      processed_at: r.processed_at,
      format: r.format,
      document_type: r.document_type,
      type_code: r.type_code,
      invoice_number: r.invoice_number,
      issue_date: r.issue_date,
      due_date: r.due_date,
      seller_name: r.seller_name,
      seller_vat_id: r.seller_vat_id,
      seller_tax_number: r.seller_tax_number,
      seller_address: r.seller_address,
      buyer_name: r.buyer_name,
      buyer_reference: r.buyer_reference,
      currency: r.currency,
      net_amount: r.net_amount,
      vat_amount: r.vat_amount,
      gross_amount: r.gross_amount,
      payable_amount: r.payable_amount,
      vat_breakdown: r.vat_breakdown
        .map(
          (/** @type {{ category: string, rate: number | null, basis: number | null, vat: number | null }} */ b) =>
            `${b.category} ${b.rate ?? '-'}%: ${money(b.basis)} + ${money(b.vat)}`,
        )
        .join('; '),
      iban: r.iban,
      payment_terms: r.payment_terms,
      line_items: JSON.stringify(r.line_items),
      file_name: r.file_name,
      file_link: id ? `https://drive.google.com/file/d/${id}/view` : '',
      email_from: r.email_from,
      email_subject: r.email_subject,
      message_id: r.message_id,
    },
    pairedItem: { item: i },
  };
});
