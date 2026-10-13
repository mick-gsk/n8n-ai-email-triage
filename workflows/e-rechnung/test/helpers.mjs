// Shared by the unit tests and the n8n cases: Code node source paths, the XRechnung test suite
// fixtures, deliberately broken copies of one of them, and a ZUGFeRD-style PDF built around an XML file.
import { readdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { runCodeNode } from '../../../lib/run-code-node.mjs';

export const src = (file) => new URL(`../src/${file}`, import.meta.url);

const suite = new URL('./fixtures/xrechnung-testsuite/', import.meta.url);
/** File names of the test suite samples, e.g. 01.01a-INVOICE_ubl.xml. */
export const fixtures = readdirSync(suite).filter((f) => f.endsWith('.xml'));
export const fixture = (name) => readFileSync(new URL(name, suite), 'utf8');
export const ubl = fixture('01.01a-INVOICE_ubl.xml');
export const cii = fixture('01.01a-INVOICE_uncefact.xml');

// Broken copies of 01.01a (UBL or CII). Each one is rejected by the KoSIT validator except
// "bad IBAN": EN 16931 and XRechnung do not check IBAN checksums.
export const broken = {
  'wrong gross': (xml) =>
    xml.replace(
      /(<(cbc:TaxInclusiveAmount|cbc:PayableAmount|ram:GrandTotalAmount|ram:DuePayableAmount)[^>]*>)336\.9</g,
      '$1363.9<',
    ),
  'wrong VAT breakdown': (xml) =>
    xml
      .replace(/(<cac:TaxSubtotal>[\s\S]*?<cbc:TaxAmount[^>]*>)22\.04/, '$120.04')
      .replace('<ram:CalculatedAmount>22.04', '<ram:CalculatedAmount>20.04'),
  'bad IBAN': (xml) => xml.replace('DE79000000001234567890', 'DE79000000001234567891'),
  'no invoice number': (xml) => xml.replace(/<(cbc|ram):ID>123456XX<\/\1:ID>/, ''),
};

/**
 * A minimal PDF with xml as embedded file, the way ZUGFeRD / Factur-X attach it: a FlateDecode
 * EmbeddedFile stream referenced from the catalog's EmbeddedFiles name tree and /AF.
 * @param {string | Buffer} xml
 * @param {{ name?: string, compress?: boolean, level?: number, indirectLength?: boolean }} [options]
 */
export function zugferdPdf(xml, { name = 'factur-x.xml', compress = true, level = 6, indirectLength = false } = {}) {
  const content = Buffer.from(xml);
  const data = compress ? deflateSync(content, { level }) : content;
  const length = indirectLength ? '7 0 R' : String(data.length);
  const page = 'BT /F1 12 Tf 72 770 Td (Rechnung) Tj ET';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(${name}) 4 0 R] >> >> /AF [4 0 R] >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R >>',
    `<< /Type /Filespec /F (${name}) /UF (${name}) /AFRelationship /Alternative /EF << /F 5 0 R /UF 5 0 R >> >>`,
    [
      `<< /Type /EmbeddedFile /Subtype /text#2Fxml ${compress ? '/Filter /FlateDecode ' : ''}/Length ${length} ` +
        `/Params << /Size ${content.length} >> >>\nstream\n`,
      data,
      '\nendstream',
    ],
    [`<< /Length ${page.length} >>\nstream\n`, page, '\nendstream'],
    String(data.length),
  ];
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([`${i + 1} 0 obj\n`, ...[body].flat(), '\nendobj\n'].map((p) => Buffer.from(p)));
    parts.push(chunk);
    size += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref)]);
}

/** A PDF without embedded files, such as the visual copy that comes with an XRechnung. */
export const plainPdf = () =>
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

let n = 0;
/**
 * One item as Read file passes it to Read e-invoice.
 * @param {string | Buffer} content
 * @param {Record<string, unknown>} [fields]
 */
export function fileItem(content, fields = {}) {
  const pdf = Buffer.from(content).subarray(0, 5).toString('latin1') === '%PDF-';
  return {
    message_id: `19a${(n++).toString(16).padStart(3, '0')}`,
    file_name: pdf ? 'rechnung.pdf' : 'rechnung.xml',
    media_type: pdf ? 'application/pdf' : 'application/xml',
    status: 'pending',
    reasons: [],
    fileBase64: Buffer.from(content).toString('base64'),
    ...fields,
  };
}

/** Runs Read e-invoice on the items. */
export const readFiles = (items) => runCodeNode(src('read-einvoice.js'), { input: items });

/** Runs Read e-invoice and Validate on one file; returns Validate's record. */
export function check(content, fields) {
  const read = readFiles([fileItem(content, fields)]);
  return runCodeNode(src('validate-einvoice.js'), { input: read })[0];
}
