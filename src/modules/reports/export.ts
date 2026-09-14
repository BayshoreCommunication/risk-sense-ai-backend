import PDFDocument from 'pdfkit';
import type { ReportResult } from './service';

/** FR-28: exports render the exact rows the screen shows — same columns, same order, same numbers. */
function cell(v: unknown, kind: string): string {
  if (v === null || v === undefined) return '';
  if (kind === 'percent') return `${v}%`;
  if (kind === 'seconds') return `${v}`;
  return String(v);
}

const csvEscape = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(r: ReportResult): string {
  const head = r.columns.map((c) => csvEscape(c.label)).join(',');
  const body = r.rows.map((row) => r.columns.map((c) => csvEscape(cell(row[c.key], c.kind))).join(','));
  return ['﻿' + head, ...body].join('\r\n') + '\r\n';
}

/** Simple tabular PDF (pdfkit — pure JS, no headless browser on Render). Landscape A4, repeating header row. */
export function toPdf(r: ReportResult, title: string, meta: { tenant: string; generatedBy: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: title, Author: 'RiskSense AI' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text(title);
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#52514e').text(`${meta.tenant} · ${r.range.from.slice(0, 10)} → ${r.range.to.slice(0, 10)} · per ${r.range.interval} · generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC by ${meta.generatedBy}`);
    const filters = Object.entries(r.params).filter(([k]) => !['from', 'to', 'interval', 'by'].includes(k));
    if (filters.length) doc.text(`Filters: ${filters.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`);
    doc.moveDown(0.8);

    const pageW = doc.page.width - 72;
    const colW = pageW / r.columns.length;
    const rowH = 16;
    let y = doc.y;
    const header = () => {
      doc.fillColor('#0b0b0b').font('Helvetica-Bold').fontSize(8);
      r.columns.forEach((c, i) => doc.text(c.label, 36 + i * colW, y, { width: colW - 4, align: c.kind === 'text' ? 'left' : 'right' }));
      y += rowH;
      doc.moveTo(36, y - 3).lineTo(36 + pageW, y - 3).strokeColor('#c3c2b7').lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(8);
    };
    header();
    for (const row of r.rows) {
      if (y + rowH > doc.page.height - 36) {
        doc.addPage();
        y = 36;
        header();
      }
      r.columns.forEach((c, i) => doc.fillColor('#0b0b0b').text(cell(row[c.key], c.kind), 36 + i * colW, y, { width: colW - 4, align: c.kind === 'text' ? 'left' : 'right' }));
      y += rowH;
    }
    doc.moveDown(1);
    const summary = Object.entries(r.summary).filter(([k, v]) => k !== 'reasons' && k !== 'series' && v !== null && v !== undefined);
    if (summary.length) {
      doc.fontSize(9).fillColor('#52514e').text(`Totals: ${summary.map(([k, v]) => `${k} ${String(v)}`).join(' · ')}`, 36, y + 6);
    }
    doc.end();
  });
}
