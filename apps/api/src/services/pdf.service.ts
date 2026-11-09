// Branded invoice and statement PDFs (A4), drawn with pdfkit's built-in
// Helvetica so nothing is fetched at render time. The firm's name and colour
// come from its brand; nothing here names a firm or product.
//
// A VAT vendor's invoice is headed "Tax invoice" and shows what the VAT Act
// (s20(4)) asks for: the firm's name, address and VAT number, the client's
// name and address, a serial number, the date, what was supplied, and the
// value with the VAT charged.
import PDFDocument from 'pdfkit';
import type {
  BillingSettings,
  ClientStatement,
  FirmBrand,
  FirmProfileSettings,
  Invoice,
} from '@ahava88/shared';

type Doc = InstanceType<typeof PDFDocument>;

export interface PdfParty {
  name: string;
  address?: string;
  reference?: string;
}

const MARGIN = 50;
const MUTED = '#5b6670';

const rand = (value: number) => {
  const [whole, cents] = Math.abs(value).toFixed(2).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 ? '-' : ''}R ${grouped}.${cents}`;
};

const day = (value: string | null) => (value ? value.slice(0, 10) : '');

/** Helvetica in pdfkit is WinAnsi: replace what it can't draw. */
function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/→/g, '->')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '?');
}

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function newDocument(title: string): Doc {
  return new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    info: { Title: safe(title) },
    bufferPages: true,
  });
}

/** Optional letterhead details: the uploaded logo (PNG or JPEG) and practice details. */
export interface Letterhead {
  logo?: Buffer | null;
  profile?: Partial<FirmProfileSettings>;
}

function letterhead(doc: Doc, brand: FirmBrand, settings: BillingSettings, extra: Letterhead = {}) {
  if (extra.logo) {
    try {
      doc.image(extra.logo, MARGIN, MARGIN, { fit: [180, 60] });
      doc.y = MARGIN + 66;
    } catch {
      // An image pdfkit can't draw (e.g. WebP): the name alone is used.
    }
  }
  doc.fillColor(brand.primaryColor).font('Helvetica-Bold').fontSize(18).text(safe(brand.firmName));
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (brand.firmShortName && brand.firmShortName !== brand.firmName) {
    doc.text(safe(`Trading as ${brand.firmShortName}`));
  }
  if (settings.address) doc.text(safe(settings.address));
  const profile = extra.profile ?? {};
  const contact = [profile.phone, profile.email, profile.website].filter(Boolean).join(' · ');
  if (contact) doc.text(safe(contact));
  const numbers = [
    profile.registrationNumber ? `Reg. ${profile.registrationNumber}` : '',
    settings.vatNumber ? `VAT ${settings.vatNumber}` : '',
    profile.lpcNumber ? `LPC ${profile.lpcNumber}` : '',
    profile.fidelityFundCertificate
      ? `Fidelity Fund certificate ${profile.fidelityFundCertificate}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (numbers) doc.text(safe(numbers));
  doc.moveDown(0.5);
  const y = doc.y;
  doc
    .moveTo(MARGIN, y)
    .lineTo(doc.page.width - MARGIN, y)
    .lineWidth(1.5)
    .strokeColor(brand.primaryColor)
    .stroke();
  doc.moveDown(1);
  doc.fillColor('black');
}

function twoColumns(doc: Doc, left: string[], right: Array<[string, string]>) {
  const top = doc.y;
  const width = doc.page.width - MARGIN * 2;
  doc.font('Helvetica').fontSize(10);
  doc.text(left.map(safe).join('\n'), MARGIN, top, { width: width / 2 - 10 });
  const leftBottom = doc.y;
  let y = top;
  for (const [label, value] of right) {
    doc.font('Helvetica-Bold').text(label, MARGIN + width / 2, y, { width: 100 });
    doc
      .font('Helvetica')
      .text(safe(value), MARGIN + width / 2 + 100, y, { width: width / 2 - 100 });
    y = doc.y;
  }
  doc.x = MARGIN;
  doc.y = Math.max(leftBottom, y) + 12;
}

interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

function table(doc: Doc, columns: Column[], rows: string[][], accent: string) {
  const header = () => {
    const y = doc.y;
    doc.rect(MARGIN, y - 3, doc.page.width - MARGIN * 2, 16).fill(accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
    let x = MARGIN + 4;
    for (const column of columns) {
      doc.text(column.label, x, y, { width: column.width - 8, align: column.align ?? 'left' });
      x += column.width;
    }
    doc.fillColor('black').font('Helvetica').fontSize(9);
    doc.y = y + 18;
  };
  header();
  for (const row of rows) {
    const heights = row.map((cell, index) =>
      doc.heightOfString(safe(cell), { width: columns[index]!.width - 8 }),
    );
    const height = Math.max(...heights, 10);
    if (doc.y + height > doc.page.height - MARGIN - 60) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    let x = MARGIN + 4;
    row.forEach((cell, index) => {
      const column = columns[index]!;
      doc.text(safe(cell), x, y, { width: column.width - 8, align: column.align ?? 'left' });
      x += column.width;
    });
    doc.y = y + height + 5;
    doc
      .moveTo(MARGIN, doc.y - 2)
      .lineTo(doc.page.width - MARGIN, doc.y - 2)
      .lineWidth(0.3)
      .strokeColor('#d5dbe0')
      .stroke();
  }
  doc.x = MARGIN;
}

function totalsBlock(doc: Doc, rows: Array<[string, string, boolean?]>) {
  const width = doc.page.width - MARGIN * 2;
  doc.moveDown(0.5);
  for (const [label, value, strong] of rows) {
    const y = doc.y;
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11 : 10);
    doc.text(label, MARGIN + width - 260, y, { width: 150, align: 'right' });
    doc.text(value, MARGIN + width - 100, y, { width: 100, align: 'right' });
    doc.y = y + (strong ? 16 : 14);
  }
  doc.x = MARGIN;
}

function stamp(doc: Doc, text: string) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc
      .font('Helvetica-Bold')
      .fontSize(90)
      .fillColor('#c0392b')
      .opacity(0.15)
      .text(text, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore();
  }
}

function pageNumbers(doc: Doc, label: string) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    // Writing inside the bottom margin would otherwise start a new page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        safe(`${label} - page ${index + 1} of ${range.count}`),
        MARGIN,
        doc.page.height - MARGIN + 10,
        { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }
}

export async function invoicePdf(
  invoice: Invoice,
  brand: FirmBrand,
  settings: BillingSettings,
  client: PdfParty,
  extra: Letterhead = {},
): Promise<Buffer> {
  const heading = settings.vatRegistered && invoice.vat > 0 ? 'Tax invoice' : 'Invoice';
  const number = invoice.number ?? 'Draft';
  const doc = newDocument(`${heading} ${number}`);
  const done = collect(doc);

  letterhead(doc, brand, settings, extra);
  doc.font('Helvetica-Bold').fontSize(16).text(heading.toUpperCase());
  doc.moveDown(0.5);
  twoColumns(
    doc,
    [
      'Bill to:',
      client.name,
      ...(client.address ? [client.address] : []),
      ...(client.reference ? [`Client ${client.reference}`] : []),
    ],
    [
      ['Invoice', number],
      ['Date', day(invoice.issuedAt) || day(invoice.createdAt)],
      ['Due', day(invoice.dueAt)],
      ['Matter', invoice.caseNumber ?? ''],
    ],
  );
  doc.font('Helvetica-Bold').fontSize(11).text(safe(invoice.subject));
  doc.moveDown(0.5);

  table(
    doc,
    [
      { label: 'Date', width: 65 },
      { label: 'Description', width: 225 },
      { label: 'Qty', width: 50, align: 'right' },
      { label: 'Rate', width: 75, align: 'right' },
      { label: 'Amount', width: 80, align: 'right' },
    ],
    invoice.lines.map((line) => [
      line.workDate ?? '',
      [
        line.kind === 'disbursement' ? `Disbursement: ${line.description}` : line.description,
        line.feeEarner ? `(${line.feeEarner})` : '',
        settings.vatRegistered && !line.vatable ? '[no VAT]' : '',
      ]
        .filter(Boolean)
        .join(' '),
      line.kind === 'fee' ? `${line.quantity.toFixed(1)} h` : String(line.quantity),
      rand(line.unitPrice),
      rand(line.amount),
    ]),
    brand.primaryColor,
  );

  const vatLabel = `VAT (${Math.round(invoice.vatRate * 10_000) / 100}%)`;
  totalsBlock(doc, [
    ['Subtotal', rand(invoice.subtotal)],
    ...(settings.vatRegistered ? ([[vatLabel, rand(invoice.vat)]] as Array<[string, string]>) : []),
    ['Total', rand(invoice.total), true],
    ...(invoice.paid ? ([['Paid', rand(-invoice.paid)]] as Array<[string, string]>) : []),
    ...(invoice.status !== 'draft' && invoice.status !== 'void'
      ? ([['Balance due', rand(invoice.balance), true]] as Array<[string, string, boolean]>)
      : []),
  ]);

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(9).fillColor('black');
  if (invoice.notes) {
    doc.text(safe(invoice.notes));
    doc.moveDown(0.5);
  }
  if (settings.bankDetails) {
    doc.font('Helvetica-Bold').text('Payment details');
    doc.font('Helvetica').text(safe(settings.bankDetails));
    doc.text(`Reference: ${number}`);
    doc.moveDown(0.5);
  }
  if (settings.invoiceFooter) {
    doc.fillColor(MUTED).text(safe(settings.invoiceFooter));
  }

  if (invoice.status === 'void') stamp(doc, 'VOID');
  if (invoice.status === 'draft') stamp(doc, 'DRAFT');
  pageNumbers(doc, `${heading} ${number}`);
  doc.end();
  return done;
}

export async function statementPdf(
  statement: ClientStatement,
  brand: FirmBrand,
  settings: BillingSettings,
  client: PdfParty,
  extra: Letterhead = {},
): Promise<Buffer> {
  const doc = newDocument(`Statement ${statement.partyNumber} ${statement.to}`);
  const done = collect(doc);

  letterhead(doc, brand, settings, extra);
  doc.font('Helvetica-Bold').fontSize(16).text('STATEMENT OF ACCOUNT');
  doc.moveDown(0.5);
  twoColumns(
    doc,
    [client.name, ...(client.address ? [client.address] : []), `Client ${statement.partyNumber}`],
    [
      ['Period', `${statement.from ?? 'Opening'} to ${statement.to}`],
      ['Balance', rand(statement.closingBalance)],
    ],
  );

  const rows: string[][] = [];
  if (statement.from) {
    rows.push([statement.from, 'Opening balance', '', '', '', rand(statement.openingBalance)]);
  }
  for (const line of statement.lines) {
    rows.push([
      line.date,
      line.kind === 'invoice' ? `Invoice ${line.reference}` : `Payment ${line.reference}`,
      line.caseNumber,
      line.debit ? rand(line.debit) : '',
      line.credit ? rand(line.credit) : '',
      rand(line.balance),
    ]);
  }
  table(
    doc,
    [
      { label: 'Date', width: 65 },
      { label: 'Details', width: 135 },
      { label: 'Matter', width: 80 },
      { label: 'Debit', width: 70, align: 'right' },
      { label: 'Credit', width: 70, align: 'right' },
      { label: 'Balance', width: 75, align: 'right' },
    ],
    rows,
    brand.primaryColor,
  );

  doc.moveDown(1);
  const aging = statement.aging;
  table(
    doc,
    [
      { label: 'Current', width: 82, align: 'right' },
      { label: '30 days', width: 82, align: 'right' },
      { label: '60 days', width: 82, align: 'right' },
      { label: '90 days', width: 82, align: 'right' },
      { label: '120+ days', width: 82, align: 'right' },
      { label: 'Total due', width: 85, align: 'right' },
    ],
    [
      [aging.current, aging.days30, aging.days60, aging.days90, aging.days120, aging.total].map(
        rand,
      ),
    ],
    brand.accentColor,
  );

  if (settings.bankDetails) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('black').text('Payment details');
    doc.font('Helvetica').text(safe(settings.bankDetails));
    doc.text(`Reference: ${statement.partyNumber}`);
  }
  pageNumbers(doc, `Statement ${statement.partyNumber}`);
  doc.end();
  return done;
}
