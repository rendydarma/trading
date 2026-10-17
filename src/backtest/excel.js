import ExcelJS from 'exceljs';

const H = 3600000;
const utc = (t) => (t == null ? null : new Date(t).toISOString());
const wib = (t) => (t == null ? null : new Date(t + 7 * H).toISOString().slice(0, 16).replace('T', ' '));
const cell = (v) => (Array.isArray(v) ? v.join(',') : v ?? null);

const TRADE_COLS = [
  '#', 'Decision (UTC)', 'Side', 'Entry (UTC)', 'Entry (WIB)', 'Entry Price', 'SL', 'TP', 'Exit (UTC)', 'Exit (WIB)',
  'Exit Reason', 'Exit Price', 'Hold (h)', 'Size', 'Fees', 'P/L', 'P/L %', 'R', 'Equity After', 'Rationale',
];

function sheet(wb, name, header, rows, widths) {
  const ws = wb.addWorksheet(name);
  if (header) ws.addRow(header).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c, i) => { c.width = widths[i] ?? 14; });
  return ws;
}

export async function writeReport(path, { params = {}, summary = {}, trades = [], decisions = [] }) {
  const wb = new ExcelJS.Workbook();
  const initial = params.initialCapital ?? 0;

  const pRows = Object.entries(params).map(([k, v]) => [k, cell(v)]);
  const sRows = Object.entries(summary).map(([k, v]) => [k, cell(v)]);
  const sm = sheet(wb, 'Summary', null, [...pRows, [], ...sRows], [24, 28]);
  sm.getColumn(1).font = { bold: true };

  // Equity After accumulates in exit order; open trades have none.
  const equityAfter = new Map();
  let eq = initial;
  for (const t of trades.filter((x) => x.status !== 'open').sort((a, b) => a.exitTime - b.exitTime)) equityAfter.set(t, (eq += t.pnl));

  const tRows = trades.map((t, i) => [
    i + 1, utc(t.decidedAt), t.side, utc(t.entryTime), wib(t.entryTime), t.entryPrice, t.sl, t.tp, utc(t.exitTime), wib(t.exitTime),
    t.status, t.exitPrice ?? null, t.exitTime == null ? null : (t.exitTime - t.entryTime) / H, t.size, t.fees ?? null,
    t.pnl ?? null, t.pnlPct ?? null, t.r ?? null, equityAfter.get(t) ?? null, t.rationale ?? '',
  ]);
  sheet(wb, 'Trades', TRADE_COLS, tRows, [5, 26, 7, 26, 18, 12, 12, 12, 26, 18, 12, 12, 9, 12, 10, 10, 9, 8, 13, 60]);

  sheet(wb, 'Decisions', ['Step', 'Time (UTC)', 'Action', 'Rationale'], decisions.map((d) => [d.step, d.time, d.action, d.rationale ?? '']), [7, 26, 9, 80]);
  await wb.xlsx.writeFile(path);
}
