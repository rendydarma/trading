// BTCUSDT futures trade plan: 3 setups (continuation, pullback, reversal), long+short, regime from 4h.
// Signals on 1h close, entry at next 15m open, SL/TP/trailing checked on 15m (SL wins ties).
// Run: node strategy.js [fee=0.0005] [delayBars15m=0]  -> monthly table + TRADES.xlsx
// PROFILE=aktif   -> ~13 trades/month (utama + small-risk A2), output TRADES_aktif.xlsx
// FROM=2026-09-01 TO=2026-10-01 -> fresh 100 USDT, trades only inside [FROM, TO), open position closed at
// last 15m close before TO, output TRADES[_profile]_<FROM>_<TO>.xlsx. Indicators still use full history.
import fs from 'fs';
import ExcelJS from 'exceljs';

const PROFILES = {
  utama: {
    risk: 0.03, lev: 10, start: 100, makerTP: false,
    ctAdx: 35, ctVol: 2, ctSL: 2, ctTP: 3, ctTrail: 3,   // continuation
    pbAdx: 35, pbWin: 8, pbRsi: 40, pbTP: 2,              // pullback
    rvAdx: 15, rvRsi: 30, rvTP: 2,                         // reversal (range only)
    a2: false, a2Risk: 0.01, a2Vol: 2, a2SL: 1.5, a2TP: 3, a2Trail: 3, a2MaxH: 24, // A2: continuation without ADX gate
  },
  // utama signals unchanged at 3%; when none fires, A2 trades at 1% risk. TP as limit (maker 0.02%)
  aktif: { makerTP: true, a2: true },
};
const profile = process.env.PROFILE ?? 'utama';
if (!PROFILES[profile]) throw new Error(`unknown PROFILE ${profile}, use: ${Object.keys(PROFILES)}`);
const P = { ...PROFILES.utama, ...PROFILES[profile] };
const fee = +(process.argv[2] ?? 0.0005), delay = +(process.argv[3] ?? 0), H = 3600e3;
const { FROM, TO } = process.env, from = FROM ? Date.parse(FROM + 'T00:00Z') : -Infinity, to = TO ? Date.parse(TO + 'T00:00Z') : Infinity;

const load = f => {
  const [h, ...r] = fs.readFileSync(`data/BTCUSDT_${f}.csv`, 'utf8').trim().split('\n');
  const k = h.split(',');
  return r.map(l => Object.fromEntries(l.split(',').map((v, i) => [k[i], k[i] === 'time_utc' ? v : +v])));
};
const m15 = load('15m'), h1 = load('1h'), h4 = load('4h');
const i15 = new Map(m15.map((b, i) => [b.t, i]));
const at4 = []; { let j = -1; for (const b of h1) { while (j + 1 < h4.length && h4[j + 1].t + 4 * H <= b.t + H) j++; at4.push(j); } }
const lo = (k, n) => Math.min(...h1.slice(k - n + 1, k + 1).map(b => b.low));
const hi = (k, n) => Math.max(...h1.slice(k - n + 1, k + 1).map(b => b.high));
// 4h regime: +1 up (EMA50>EMA200 and close>EMA200), -1 down, 0 mixed
const regime = y => (y.ema50 > y.ema200 && y.close > y.ema200 ? 1 : y.ema50 < y.ema200 && y.close < y.ema200 ? -1 : 0);
// structural stop beyond last n bars' extreme + 0.2 ATR; null if stop is too tight/wide
const swingStop = (k, s, n) => {
  const x = h1[k], st = s > 0 ? lo(k, n) - 0.2 * x.atr14 : hi(k, n) + 0.2 * x.atr14, d = s * (x.close - st);
  return d > 0.5 * x.atr14 && d < 4 * x.atr14 ? d : null;
};

function signal(k) {
  if (k < 30 || at4[k] < 0) return;
  const x = h1[k], pr = h1[k - 1], y = h4[at4[k]], r = regime(y);
  for (const s of [1, -1]) {
    // A. CONTINUATION: strong 4h trend, 1h close breaks prior 24h high/low with volume spike
    if (r === s && y.adx14 >= P.ctAdx && x.vol_ratio >= P.ctVol && (s > 0 ? x.close > pr.don_high_1d : x.close < pr.don_low_1d))
      return { s, d: P.ctSL * x.atr14, tp: P.ctTP, trail: P.ctTrail * x.atr14, tag: 'continuation', maxH: 72 };
    // B. PULLBACK: strong 4h trend, 1h RSI dipped (<=40 / >=60) in last 8 bars, 1h close reclaims EMA20
    if (r === s && y.adx14 >= P.pbAdx && s * (x.close - x.ema20) > 0 && s * (pr.close - pr.ema20) <= 0
      && h1.slice(k - P.pbWin, k).some(b => (s > 0 ? b.rsi14 <= P.pbRsi : b.rsi14 >= 100 - P.pbRsi))) {
      const d = swingStop(k, s, P.pbWin); if (d) return { s, d, tp: P.pbTP, tag: 'pullback', maxH: 72 };
    }
    // C. REVERSAL: no 4h trend (ADX<15), prev 1h closed outside Bollinger with RSI extreme, now closes back inside
    if (y.adx14 < P.rvAdx && (s > 0 ? pr.close < pr.bb_lower && x.close > x.bb_lower && pr.rsi14 <= P.rvRsi
      : pr.close > pr.bb_upper && x.close < x.bb_upper && pr.rsi14 >= 100 - P.rvRsi)) {
      const d = swingStop(k, s, 3); if (d) return { s, d, tp: P.rvTP, tag: 'reversal', maxH: 24 };
    }
  }
  // A2. CONTINUATION (small risk): any 4h trend regime, same breakout + volume, tighter stop, short hold
  if (P.a2) for (const s of [1, -1])
    if (r === s && x.vol_ratio >= P.a2Vol && (s > 0 ? x.close > pr.don_high_1d : x.close < pr.don_low_1d))
      return { s, d: P.a2SL * x.atr14, tp: P.a2TP, trail: P.a2Trail * x.atr14, tag: 'continuation2', maxH: P.a2MaxH, risk: P.a2Risk };
}

let eq = P.start, pos = null;
const trades = [], monthsSeen = new Set();
const close = (px, t, tpHit) => {
  const fund = 0.0001 * pos.qty * pos.e * Math.floor((t - pos.t0) / (8 * H)); // conservative funding
  const exitFee = tpHit && P.makerTP ? 0.0002 : fee; // TP as resting limit order = maker
  const pnl = pos.s * (px - pos.e) * pos.qty - fee * pos.qty * pos.e - exitFee * pos.qty * px - fund;
  eq += pnl;
  const closeTime = new Date(t).toISOString().slice(0, 16);
  trades.push({ open: new Date(pos.t0).toISOString().slice(0, 16), close: closeTime, month: closeTime.slice(0, 7), setup: pos.tag,
    side: pos.s > 0 ? 'LONG' : 'SHORT', entry: pos.e, sl: +pos.sl0.toFixed(1), tp: +pos.tp.toFixed(1), exit: +px.toFixed(1), qty: +pos.qty.toFixed(3),
    R: +(pnl / (pos.qty * pos.d)).toFixed(2), pnl: +pnl.toFixed(6), equity: +eq.toFixed(6) });
  pos = null;
};
for (let k = 0; k < h1.length; k++) {
  const b = h1[k], ym = b.time_utc.slice(0, 7);
  if (b.t < from) continue;
  if (b.t >= to) break;
  monthsSeen.add(ym);
  const s15 = i15.get(b.t);
  if (pos && s15 != null) for (let q = s15; q < s15 + 4 && q < m15.length; q++) {
    const c = m15[q]; if (c.t < pos.t0) continue;
    const long = pos.s > 0;
    let px = null, tpHit = false;
    if (long ? c.low <= pos.sl : c.high >= pos.sl) px = long ? Math.min(pos.sl, c.open) : Math.max(pos.sl, c.open);
    else if (long ? c.high >= pos.tp : c.low <= pos.tp) { px = long ? Math.max(pos.tp, c.open) : Math.min(pos.tp, c.open); tpHit = true; }
    else if (c.t + 15 * 60e3 - pos.t0 >= pos.maxH * H) px = c.close;
    if (px != null) { close(px, c.t, tpHit); break; }
    if (pos.trail) { const ns = c.close - pos.s * pos.trail; if (pos.s * (ns - pos.sl) > 0) pos.sl = ns; }
  }
  if (pos) continue;
  const g = signal(k), e15 = g && i15.get(b.t + H + delay * 15 * 60e3);
  if (e15 == null) continue;
  const e = m15[e15].open;
  const qty = Math.min(Math.floor(eq * (g.risk ?? P.risk) / g.d / 0.001), Math.floor(eq * P.lev / e / 0.001)) * 0.001; // 0.001 BTC step
  if (qty * e < 50) continue; // Binance BTCUSDT min notional 50 USDT
  pos = { s: g.s, e, d: g.d, sl: e - g.s * g.d, sl0: e - g.s * g.d, tp: e + g.s * g.d * g.tp, qty, t0: m15[e15].t, maxH: g.maxH, trail: g.trail, tag: g.tag };
}
if (pos) { const last = m15.findLast(c => c.t + 15 * 60e3 <= to); close(last.close, last.t); }

// per month (by trade close month): equity at start, trades, wins, pnl
let e0 = P.start;
const monthly = [...monthsSeen].map(m => {
  const a = trades.filter(t => t.month === m), pnl = a.reduce((x, t) => x + t.pnl, 0);
  const row = { m, start: e0, n: a.length, win: a.filter(t => t.pnl > 0).length, pnl, ret: pnl / e0 };
  e0 += pnl;
  return row;
});
console.log('month    start    end      %');
for (const r of monthly) console.log(r.m, r.start.toFixed(2).padStart(8), (r.start + r.pnl).toFixed(2).padStart(8), (r.ret * 100).toFixed(1).padStart(6));
let peak = P.start, dd = 0; for (const t of trades) { peak = Math.max(peak, t.equity); dd = Math.max(dd, 1 - t.equity / peak); }
for (const tag of ['continuation', 'pullback', 'reversal', 'continuation2']) {
  const a = trades.filter(t => t.setup === tag);
  console.log(tag.padEnd(13), 'n', a.length, 'win', a.filter(t => t.R > 0).length, 'sumR', a.reduce((x, t) => x + t.R, 0).toFixed(1));
}
console.log(`profile ${profile}: final ${eq.toFixed(2)} USDT, trades ${trades.length}, maxDD ${(dd * 100).toFixed(1)}%, fee ${fee}, delay ${delay}x15m`);

// xlsx: Trades (values), Ringkasan (monthly formulas over Trades), Parameter
const out = 'TRADES' + (profile === 'utama' ? '' : '_' + profile) + (FROM || TO ? `_${FROM ?? 'start'}_${TO ?? 'end'}` : '') + '.xlsx';
const wb = new ExcelJS.Workbook(), font = { name: 'Arial', size: 10 }, bold = { ...font, bold: true };
const cols = [['No', 'no', 6], ['Open (UTC)', 'open', 17], ['Close (UTC)', 'close', 17], ['Bulan', 'month', 9], ['Setup', 'setup', 13], ['Side', 'side', 7],
  ['Entry', 'entry', 10, '#,##0.0'], ['SL', 'sl', 10, '#,##0.0'], ['TP', 'tp', 10, '#,##0.0'], ['Exit', 'exit', 10, '#,##0.0'], ['Qty (BTC)', 'qty', 9, '0.000'],
  ['R', 'R', 7, '0.00;[Red]-0.00'], ['PnL (USDT)', 'pnl', 11, '#,##0.00;[Red]-#,##0.00'], ['Equity (USDT)', 'equity', 13, '#,##0.00']];
const rs = wb.addWorksheet('Ringkasan'), ws = wb.addWorksheet('Trades', { views: [{ state: 'frozen', ySplit: 1 }] }); // tab order
ws.columns = cols.map(([header, key, width, numFmt]) => ({ header, key, width, style: { font, numFmt } }));
trades.forEach((t, i) => ws.addRow({ no: i + 1, ...t }));
ws.getRow(1).font = bold;
ws.autoFilter = { from: 'A1', to: `N${trades.length + 1}` };

const pr = wb.addWorksheet('Parameter');
pr.columns = [{ header: 'Parameter', key: 'k', width: 16 }, { header: 'Nilai', key: 'v', width: 14 }];
// row 2 = start equity (number), referenced by Ringkasan!B2
[['start', P.start], ['profile', profile], ...Object.entries(P).filter(([k]) => k !== 'start'), ['fee taker', fee], ['delay 15m', delay], ['FROM', FROM ?? ''], ['TO', TO ?? '']]
  .forEach(([k, v]) => pr.addRow({ k, v: typeof v === 'number' ? v : String(v) }));
pr.eachRow(r => { r.font = font; }); pr.getRow(1).font = bold;

rs.columns = [['Bulan', 9], ['Equity awal', 12, '#,##0.00'], ['Trades', 8, '0'], ['Win', 6, '0'], ['Win rate', 9, '0.0%'], ['PnL (USDT)', 12, '#,##0.00;[Red]-#,##0.00'],
  ['Equity akhir', 12, '#,##0.00'], ['Return', 9, '0.0%;[Red]-0.0%']].map(([header, width, numFmt]) => ({ header, width, style: { font, numFmt } }));
const n = Math.max(trades.length + 1, 2), T = c => `Trades!$${c}$2:$${c}$${n}`;
monthly.forEach(({ m, start, n: cnt, win, pnl, ret }, j) => {
  const r = j + 2;
  rs.addRow([m,
    j ? { formula: `G${r - 1}`, result: start } : { formula: 'Parameter!$B$2', result: start },
    { formula: `COUNTIFS(${T('D')},A${r})`, result: cnt },
    { formula: `COUNTIFS(${T('D')},A${r},${T('M')},">0")`, result: win },
    { formula: `IF(C${r}=0,0,D${r}/C${r})`, result: cnt ? win / cnt : 0 },
    { formula: `SUMIFS(${T('M')},${T('D')},A${r})`, result: pnl },
    { formula: `B${r}+F${r}`, result: start + pnl },
    { formula: `IF(B${r}=0,0,F${r}/B${r})`, result: ret }]);
});
const monthRet = monthly.map(r => r.ret);
const last = monthly.length + 1, tot = last + 1, wins = trades.filter(t => t.pnl > 0).length, sumPnl = trades.reduce((x, t) => x + t.pnl, 0);
rs.addRow(['Total', { formula: 'B2', result: P.start }, { formula: `SUM(C2:C${last})`, result: trades.length }, { formula: `SUM(D2:D${last})`, result: wins },
  { formula: `IF(C${tot}=0,0,D${tot}/C${tot})`, result: trades.length ? wins / trades.length : 0 }, { formula: `SUM(F2:F${last})`, result: sumPnl },
  { formula: `G${last}`, result: P.start + sumPnl }, { formula: `F${tot}/B${tot}`, result: sumPnl / P.start }]);
rs.addRow(['Bulan profit', null, { formula: `COUNTIF(H2:H${last},">0")`, result: monthRet.filter(v => v > 0).length }]);
rs.addRow(['Bulan terburuk', null, null, null, null, null, null, { formula: `MIN(H2:H${last})`, result: Math.min(...monthRet) }]);
rs.getRow(1).font = bold; rs.getRow(tot).font = bold;
rs.addRow([]);
rs.addRow([`Bulan = bulan close trade. Fee taker ${fee}${P.makerTP ? ', TP maker 0.0002' : ''}, funding 0.01%/8 jam. Sumber: node strategy.js, data/BTCUSDT_*.csv.`]);
await wb.xlsx.writeFile(out);
console.log('wrote', out);
