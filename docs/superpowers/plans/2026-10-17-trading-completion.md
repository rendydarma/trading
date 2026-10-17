# Trading-MCP Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps found in the project review (order safety, noisy output, missing tests, indicators not reachable by the LLM) and add Indonesian prompt templates (Indikator, Analisa, Backtest) with input/output styles, intent routing, and a blind-forward backtest that exports real trades to Excel.

**Architecture:** Keep the existing ccxt + MCP stdio server. New logic lives in small modules under `src/` (`candles`, `slim`, `guard`, `indicatorReport`, `templates`, `backtest/*`) and new MCP tools register from `src/tools/*.js`. Prompt templates are Markdown files with YAML frontmatter in `prompts/`; a router (`CLAUDE.md` + `get_prompt_template` tool) picks one per user intent. The backtest is driven by Claude through `backtest_step` → `backtest_decide` loops; the server alone holds future candles and settles trades, so the model only ever sees data up to the decision time.

**Tech Stack:** Node >=18 (ESM), `@modelcontextprotocol/sdk`, `ccxt`, `zod`, `dotenv` (existing); new: `yaml` (frontmatter), `exceljs` (xlsx). Tests: built-in `node:test` + `node:assert/strict`.

**Spec:** No separate design doc. Decisions are in the "Decisions" section below, taken from the brainstorming conversation (user answers: routing by intent to `.md` templates in `prompts/`; backtest = real data, blind-forward, real template prompt, output = trade list with entry/TP/SL/time/P&L in Excel with summary). Items marked *(my call)* were not decided by the user.

## Decisions

- Routing (user): "analisa" → template A (`analysis`); a question like "vwap 1 bulan aset A" → template B (`indicator`) run with script X (`scripts/indicators.js`). Templates really exist as files in `prompts/`.
- Backtest (user): blind-forward. At each historical decision time *t* the model sees candles with `time + tfMs <= t` only, decides with the real Analisa prompt, and the outcome is computed from candles after *t*.
- Backtest defaults *(my call)*: 30 days, decision every 4 h (~180 steps), timeframes `1h,4h,1d`, market entry at the open of the first base-timeframe (`1h`) candle at/after *t*, one open position at a time, max hold 48 h, fee 0.1 %/side, slippage 0.05 %, initial capital 1000 (quote), risk 1 % of equity per trade, no leverage (notional ≤ equity). Same-candle TP and SL ⇒ SL wins. Gap through SL ⇒ exit at that candle's open.
- Excel *(my call)*: sheets `Summary`, `Trades`, `Decisions`; times in UTC ISO plus WIB (UTC+7) columns for entry/exit.
- Output styles *(my call)*: Analisa `ringkas|detail|json|keputusan`; Indikator `tabel|narasi|json`; Backtest `ringkasan|lengkap|excel`. Input styles: Analisa `ringkas|lengkap`; Indikator `cepat|periode`; Backtest `cepat|kustom`.
- Order safety *(my call)*: live orders need `TRADING_LIVE=true`, `MAX_ORDER_NOTIONAL` set, optional `ALLOWED_SYMBOLS`; otherwise `create_order` stays dry-run. `confirm` stays but is documented as not a guard.
- Env rename *(my call)*: `TOKOCRYPTO_*` is primary, legacy `TOKOCYPTO_*` still read so the existing `.env` keeps working. `.env` itself is never edited or printed.
- Known limitation: the model may remember real historical prices from training. Default window is the most recent 30 days to reduce this; no anonymisation.
- Known limitation: ~180 steps in one chat grows context. Step payloads are compact (`compactSnapshot`), `backtest_status` lets a run be resumed in a fresh session/subagent.

## Global Constraints

- Node `>=18`, ESM only (`"type": "module"`). Tests run with `npm test` = `node --test tests/`.
- stdout is the MCP protocol channel: never `console.log` in anything under `src/` that the server imports; use `console.error`.
- Never print, log, or return API keys/secrets. Do not read or modify `.env`.
- Candles are closed candles only; shape `{time, open, high, low, close, volume}` (ms epoch, oldest first).
- No new dependencies beyond `yaml` and `exceljs`.
- Template text is Indonesian; code identifiers and comments English. Comment density follows existing files (sparse).
- Times in tool outputs: ISO-8601 UTC.
- Backtest artifacts go to `backtests/<runId>/` (git-ignored).

## Review Focus

- Backtest with zero trades (model answers `none` every step): Excel still written, stats are `0` not `NaN`/`null` except `profitFactor: null`. Owned by Task 9/11.
- Decision with invalid levels (long with `sl >= lastClose` or `tp <= lastClose`, shorts mirrored, NaN, missing sl/tp): rejected with a message, state unchanged. Owned by Task 10.
- Wrong or repeated `stepIndex` on `backtest_decide`: rejected, no step skipped, no double trade. Owned by Task 10.
- Server restarted mid-run: `backtest_step` resumes from `state.json` at the same step. Owned by Task 10.
- Symbol/range with too little data (`< 30` base candles or no candles): clear error, no partial run directory left. Owned by Task 3/10.

---

### Task 1: Baseline repo and test runner

**Files:**
- Create: `tests/selftest.test.js`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: `npm test` runs every `tests/*.test.js`. Later tasks add files there.

- [ ] **Step 1: Write the failing test** `tests/selftest.test.js`: spawn `node scripts/indicators.js --test` with `execFileSync` (cwd = repo root, via `import.meta.url`) and assert stdout includes `self-test OK`.
- [ ] **Step 2: Run** `node --test tests/` → expected: runs and PASSES (existing script). Then add the `test` script so `npm test` also works: `"test": "node --test tests/"`.
- [ ] **Step 3: Append `backtests/` to `.gitignore`**; run `git init`, then verify `git status --short` does NOT list `.env` or `node_modules`.
- [ ] **Step 4: Commit** `git add -A && git commit -m "chore: baseline, npm test runner"`.

### Task 2: Env rename with legacy fallback, sandbox guard

**Files:**
- Modify: `src/config.js`, `src/exchange.js`, `.env.example`, `scripts/test-tokocrypto.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `loadCredentials(entry)` unchanged signature `{apiKey, secret}`; registry entry gains `legacyApiKeyEnv`, `legacySecretEnv`.

- [ ] **Step 1: Write failing tests** (`tests/config.test.js`), manipulating `process.env` and restoring after:
  - `TOKOCRYPTO_API_KEY=new` and `TOKOCYPTO_API_KEY=old` → `apiKey === 'new'`.
  - only `TOKOCYPTO_API_KEY=old` → `apiKey === 'old'`.
  - neither → `apiKey === ''`.
- [ ] **Step 2: Run** `node --test tests/config.test.js` → FAIL.
- [ ] **Step 3: Implement** in `src/config.js`: rename `apiKeyEnv/secretEnv` for tokocrypto to `TOKOCRYPTO_*`, add `legacy*` fields (`TOKOCYPTO_*`), `loadCredentials` returns `process.env[primary] || process.env[legacy] || ''`. Update `.env.example` (new names, add `TRADING_LIVE=false`, `MAX_ORDER_NOTIONAL=`, `ALLOWED_SYMBOLS=`) and `scripts/test-tokocrypto.js` (use `loadCredentials(EXCHANGE_REGISTRY.tokocrypto)`).
- [ ] **Step 4: Sandbox guard** in `src/exchange.js`: before `setSandboxMode(true)`, check `exchange.urls?.test`; if absent throw `Error('<id> has no sandbox/testnet in ccxt; unset <sandboxEnv>')`. Verify with `node -e "import('ccxt').then(m=>console.log(!!new m.default.tokocrypto().urls.test))"` and note the result in the commit message.
- [ ] **Step 5: Run** `npm test` → PASS. **Commit** `fix: TOKOCRYPTO env names with legacy fallback, sandbox guard`.

### Task 3: Closed-candle fetching with pagination

**Files:**
- Create: `src/candles.js`
- Test: `tests/candles.test.js`

**Interfaces:**
- Produces:
  - `fetchClosedCandles(ex, symbol, timeframe, { since?, until?, limit = 1000, now = Date.now() }) -> Promise<{ ms: number, rows: Candle[] }>` — when `since` is undefined: one call with `limit`; when given: loops `fetchOHLCV(symbol, tf, cursor, limit)` advancing `cursor = lastTime + ms` until `cursor >= (until ?? now)` or an empty/non-advancing page; dedupes by `time`; drops candles where `time + ms > now`; drops `time > until`.
  - `sliceAsOf(rows: Candle[], ms: number, t: number) -> Candle[]` — rows with `time + ms <= t`.
- Consumes: `ex.parseTimeframe(tf)` (seconds), `ex.fetchOHLCV`.

- [ ] **Step 1: Write failing tests** with a fake `ex` (`parseTimeframe: () => 3600`, `fetchOHLCV` serving a 2500-candle hourly array in pages of 1000 starting at `since`):
  - `fetchClosedCandles(..., { since: 0, until: 2499*3600e3, now: 1e15 })` returns 2500 rows, strictly increasing, no duplicates.
  - `now` set mid-candle (`rows[10].time + 1000`) → last returned row is `rows[9]`.
  - fake returns `[]` → returns `{ms: 3600000, rows: []}` (no throw; callers decide).
  - `sliceAsOf(rows, 3600000, rows[5].time + 3600000)` has last row `rows[5]`; with `t = rows[5].time + 3599999` last row is `rows[4]`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both functions. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: closed candle fetch with pagination`.

### Task 4: Slim tool outputs, closed-only OHLCV

**Files:**
- Create: `src/slim.js`
- Modify: `src/server.js` (tools `get_ticker`, `get_order_book`, `get_ohlcv`, `get_balance`)
- Test: `tests/slim.test.js`

**Interfaces:**
- Produces: `slimTicker(t) -> {symbol, last, bid, ask, open, high, low, change, percentage, baseVolume, quoteVolume, timestamp}`; `slimBalance(b) -> { [asset]: {free, used, total} }` only where `total > 0`; `slimOrderBook(ob, depth = 20) -> {symbol, timestamp, bids, asks}` each truncated to `depth`.
- `get_ohlcv` gains `closedOnly: z.boolean().default(true)`; uses `fetchClosedCandles` and returns `[time, open, high, low, close, volume][]` when true.
- Consumes: Task 3 `fetchClosedCandles`.

- [ ] **Step 1: Write failing tests**: `slimTicker` drops `info`; `slimBalance({total:{BTC:1,ETH:0},free:{BTC:1,ETH:0},used:{BTC:0,ETH:0}})` equals `{BTC:{free:1,used:0,total:1}}`; `slimOrderBook` with 50 levels and depth 5 → 5 bids/asks.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/slim.js` and wire into the four tools in `server.js`; `get_ohlcv` with `closedOnly` true maps `fetchClosedCandles` rows back to arrays.
- [ ] **Step 4: Run** `npm test` → PASS. **Commit** `feat: slim tool outputs, closed-only ohlcv`.

### Task 5: Order guard

**Files:**
- Create: `src/guard.js`
- Modify: `src/server.js` (`create_order`), `README.md` (Safety section, finalised in Task 13)
- Test: `tests/guard.test.js`

**Interfaces:**
- Produces: `checkOrder(order: {exchange, symbol, side, type, amount, price?}, ctx: {env: Record<string,string|undefined>, lastPrice: number, minNotional?: number}) -> {ok: true, notional: number} | {ok: false, reason: string}`.
- Rules, evaluated in order: `env.TRADING_LIVE !== 'true'` → reason contains `TRADING_LIVE`; `env.MAX_ORDER_NOTIONAL` missing/NaN → reason contains `MAX_ORDER_NOTIONAL`; `ALLOWED_SYMBOLS` (comma list, case-insens) set and symbol not in it → reason contains `ALLOWED_SYMBOLS`; `notional = amount * (price ?? lastPrice)` over max → reason contains `exceeds`; `minNotional` set and notional below → reason contains `minimum`.

- [ ] **Step 1: Write failing tests** (one per rule, plus a passing case: live=true, max=100, amount 1, lastPrice 50 → `{ok:true, notional:50}`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `checkOrder`.
- [ ] **Step 4: Wire into `create_order`**: when `confirm` is true, load markets, get `lastPrice` via `fetchTicker`, `minNotional = market.limits?.cost?.min`, call `checkOrder`; if `!ok` return `{submitted:false, blocked:true, reason}`; else `amount = Number(ex.amountToPrecision(symbol, amount))`, `price` via `priceToPrecision` for limit orders, then `createOrder`. Update the tool description to say `confirm` is a model-set flag, not a safety guard.
- [ ] **Step 5: Run** `npm test` → PASS. **Commit** `feat: fail-closed order guard`.

### Task 6: Indicator hardening and anchored VWAP

**Files:**
- Modify: `src/indicators.js`
- Test: `tests/indicators.test.js`

**Interfaces:**
- Produces: `anchoredVwap(c: Candle[], anchor: 'day'|'week'|'month'|'period' = 'period') -> {value, upper, lower, devPct, anchorStart: string, candles: number} | null`. Anchor start = start of the UTC day / ISO week (Monday) / UTC month containing the last candle, or `c[0]` for `period`. `upper/lower = value ± 1` volume-weighted standard deviation of typical price; `devPct = (close/value - 1) * 100`; `null` when volume sum is 0.
- `patterns`: `pinBar` now requires `body/range <= 0.25` and dominant wick `>= 2/3 * range`, and is omitted when `hammer` or `shootingStar` is reported at the same `ago`.

- [ ] **Step 1: Write failing tests** (`tests/indicators.test.js`, helper `candle(o,h,l,c,v,time)`):
  - `anchoredVwap`: two candles with `h=l=c` 10 (vol 1) and 20 (vol 3) → `value` 17.5, `upper - value` ≈ 4.3301 (weighted sd; `near` eps 1e-3); `anchor: 'day'` on candles spanning two UTC days uses only the last day; zero volume → `null`.
  - `pinBar`: candle with body 0.1, lower wick 0.7, upper wick 0.2 of range → `pinBar` present; body 0.2/lower 0.7/upper 0.1 → `hammer` present and `pinBar` absent; body 0.5/lower 0.5 → no `pinBar`.
  - Gap coverage: `macd` of 60 constant closes → `line/signal/hist` last `=== 0`; `bollinger([1..20])` → `mid` 10.5, `upper` ≈ 22.0326 (eps 1e-3); `keltner` on 30 flat candles `(10,12,8,10)` → `upper` 16, `lower` 4; `cci` on candles `i=1..20` with `h=l=c=i` → ≈ 126.667 (eps 1e-3); `mfi` on strictly rising 20 candles → 100; `stochRsi` on strictly rising 40 closes → last `k` 50; `ichimoku` returns `null` for 77 candles and `priceVsCloud === 'above'`, `tenkanAboveKijun === true` for 100 strictly rising candles.
  - `divergence`: 50 candles with rising baseline lows `10 + 0.01*i`, dips to low 5 at index 20 and low 4 at index 40, injected `rsiSeries` with `[20]=30`, `[40]=35` → `bullish === true`, `bearish === false`.
- [ ] **Step 2: Run** `node --test tests/indicators.test.js` → FAIL (anchoredVwap/pinBar); gap-coverage tests may already pass — if one fails, fix the indicator, not the test, unless the hand-computed value above is wrong (recompute by hand before changing).
- [ ] **Step 3: Implement** `anchoredVwap` and the `pinBar` change in `src/indicators.js`. **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: anchored vwap, tighter pinBar, indicator test coverage`.

### Task 7: Indicator report, CLI flags, `get_indicators` tool

**Files:**
- Create: `src/indicatorReport.js`, `src/tools/indicators.js`
- Modify: `scripts/indicators.js`, `src/server.js` (call `registerIndicatorTools(server)`)
- Test: `tests/indicatorReport.test.js`

**Interfaces:**
- Produces: `buildReport({ ex, symbol, timeframes: string[], limit = 1000, days?: number, only?: string[] | null, vwapAnchor = 'period', now = Date.now() }) -> Promise<Report>` where `Report = { exchange, symbol, fetchedAt, timeframes: {[tf]: ComputeOutput | {error}}, mtf: {perTf, alignment} }` (same shape the script prints today). With `days`, candles for each tf are fetched via `fetchClosedCandles` with `since = now - days*86400000` plus 250 warm-up candles before `since`, and the `vwap` section is computed over only the last `days` days.
- `only` valid names: `trend|momentum|volatility|volume|levels|breakout|patterns|vwap`; each tf output then contains `{candle, close, meta}` plus the requested sections (`vwap` → `anchoredVwap(rows in range, vwapAnchor)`); unknown name → `Error` listing valid names.
- MCP tool `get_indicators(exchange, symbol, timeframes[] default ['15m','1h','1d'], days?, only?, vwap_anchor?)` returns the report as JSON text. CLI flags added: `--days N`, `--only a,b`, `--vwap-anchor day|week|month|period`.
- Consumes: Task 3 `fetchClosedCandles`, Task 6 `anchoredVwap`, existing `compute`.

- [ ] **Step 1: Write failing tests** with a fake `ex` serving synthetic hourly candles (900 rows): `buildReport({only:['vwap'], days:30, timeframes:['1h']})` → `timeframes['1h']` has keys `candle, close, meta, vwap` and no `trend`; `vwap.candles` ≈ 720; `only:['nope']` rejects with a message containing `trend` and `vwap`; without `only` output has `trend`, `momentum`, `breakout`; fewer than 30 candles → `{error}` entry for that tf.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: move the data-gathering/MTF logic out of `scripts/indicators.js` into `buildReport`; the script keeps arg parsing, `--test` self-test, `table()`, `csv()`, and calls `buildReport`. Register the tool in `src/tools/indicators.js` (`export function registerIndicatorTools(server)`).
- [ ] **Step 4: Run** `npm test` and `node scripts/indicators.js --test` → PASS. Smoke (needs network, skip if offline): `node scripts/indicators.js BTC/USDT --exchange binance --tf 1h --days 30 --only vwap` prints JSON with a `vwap.value`.
- [ ] **Step 5: Commit** `feat: get_indicators tool, --days/--only/--vwap-anchor`.

### Task 8: Prompt template engine, Analisa + Indikator templates, router

**Files:**
- Create: `src/templates.js`, `src/tools/templates.js`, `prompts/analysis.md`, `prompts/indicator.md`, `CLAUDE.md`
- Modify: `src/server.js`, `package.json` (add `yaml`)
- Test: `tests/templates.test.js`

**Interfaces:**
- Template file format: YAML frontmatter then Markdown with H2 sections. Frontmatter keys: `id`, `title`, `triggers: string[]`, `tool`, `script`, `vars: {[name]: {description, required?: boolean, default?: string}}`, `input_styles: string[]`, `output_styles: string[]`, `default_input_style`, `default_output_style`. Section names: `## peran`, `## input:<style>` (one per input style), `## instruksi`, `## output:<style>` (one per output style).
- Produces in `src/templates.js`:
  - `listTemplates(dir = 'prompts') -> TemplateMeta[]` (frontmatter only).
  - `loadTemplate(id, dir?) -> Template`.
  - `renderTemplate(id, { inputStyle?, outputStyle?, vars?: Record<string,string> }, dir?) -> { text: string, meta: TemplateMeta, vars: Record<string,string> }` — text = `peran` + `input:<inputStyle>` + `instruksi` + `output:<outputStyle>` joined by blank lines, `{var}` replaced from `vars` then `default`; missing required var → `Error('Missing vars: a, b')`; unknown style → `Error` listing valid styles; any leftover `{name}` placeholder → `Error`.
  - `matchIntent(text) -> string | null` — lowercase; priority `backtest` (triggers `backtest`, `uji mundur`) > `analysis` (`analisa`, `analisis`, `analyze`) > `indicator` (`indikator`, `indicator`, `vwap`, `rsi`, `macd`, `ema`, `sma`, `atr`, `adx`, `bollinger`, `supertrend`, `ichimoku`, `stoch`, `cci`, `mfi`, `obv`, `fibonacci`, `pivot`); triggers are read from frontmatter, not hard-coded.
- MCP tools: `list_prompt_templates()`; `get_prompt_template({ id?, text?, input_style?, output_style?, vars? })` → rendered text plus `tool`/`script` hints; id wins over `text`; neither match → error listing ids. Also `server.registerPrompt` per template with `vars` as args.
- Template content requirements:
  - `analysis.md` (`tool: get_indicators`, vars `symbol` required, `timeframes` default `15m,1h,1d`, `exchange` default `tokocrypto`, `horizon` default `intraday`, `risk_pct` default `1`; input styles `ringkas`, `lengkap`; output styles `ringkas`, `detail`, `json`, `keputusan`). `instruksi` must: require calling the tool first and never inventing numbers; weigh multi-timeframe alignment; require a "kondisi jangan trade" check. `output:detail` headings: Konteks Multi-TF, Tren, Momentum, Volatilitas & Volume, Level Kunci, Skenario Bull/Bear, Rencana Trade (entry, SL, TP, ukuran risiko, invalidasi), Jangan Trade Jika, Keyakinan. `output:json` fields: `bias, confidence, levels, plan{entry,sl,tp,riskPct}, noTradeReasons`. `output:keputusan` (used by backtest): strictly one JSON object `{"action":"long|short|none","sl":number,"tp":number,"maxHoldHours":number,"rationale":"≤2 kalimat"}` with `sl/tp/maxHoldHours` omitted when `none`, and no other text.
  - `indicator.md` (`tool: get_indicators`, `script: node scripts/indicators.js {symbol} --tf {timeframe} --days {days} --only {indicator} --vwap-anchor {anchor}`; vars `symbol` required, `indicator` required, `days` default `30`, `timeframe` default `1h`, `anchor` default `period`, `exchange` default `tokocrypto`; input styles `cepat`, `periode`; output styles `tabel`, `narasi`, `json`). `instruksi` includes the alias table mapping asked indicator → `--only` section (`vwap→vwap`; `rsi, macd, stoch, stochrsi, cci, mfi, roc, williams→momentum`; `ema, sma, adx, supertrend, ichimoku→trend`; `atr, bollinger, keltner→volatility`; `obv→volume`; `fibonacci, pivot→levels`).
  - `CLAUDE.md` at repo root: intent routing table (analisa → `analysis`, indikator/vwap/… → `indicator`, backtest → `backtest`), instruct to call `get_prompt_template` with the user's text, follow the returned instructions, never call `create_order` without explicit user approval in the same turn, and the backtest loop protocol (Task 12).

- [ ] **Step 1: Write failing tests**: `matchIntent('analisa BTC/USDT')==='analysis'`; `matchIntent('vwap 1 bulan ADA/USDT')==='indicator'`; `matchIntent('analisa vwap ADA')==='analysis'`; `matchIntent('backtest ADA 30 hari')==='backtest'`; `matchIntent('halo')===null`. Rendering matrix: for every template × every input style × every output style, `renderTemplate` with sample vars returns text with no `/\{[a-z_]+\}/` left and includes the style's section text; missing required var throws; unknown style throws. `analysis` + `keputusan` text contains `"action"`. `indicator` render with `indicator='vwap'` contains `--only vwap`.
- [ ] **Step 2: Run** → FAIL. **Step 3: `npm install yaml`**, implement `src/templates.js`, write the two template files and `CLAUDE.md`, register tools/prompts in `src/tools/templates.js` and `server.js`.
- [ ] **Step 4: Run** `npm test` → PASS (the `backtest` template does not exist yet: `matchIntent` backtest test must read triggers from the file created in Task 12 — create `prompts/backtest.md` here as a stub with valid frontmatter and all required sections containing a one-line placeholder `(diisi di Task 12)`, and flesh it out in Task 12).
- [ ] **Step 5: Commit** `feat: prompt templates, intent router, analysis+indicator templates`.

### Task 9: Backtest core — fills, settlement, sizing, stats

**Files:**
- Create: `src/backtest/settle.js`, `src/backtest/stats.js`
- Test: `tests/backtestCore.test.js`

**Interfaces:**
- Produces in `settle.js`:
  - `fillEntry(candles: Candle[], decidedAt: number, side: 'long'|'short', slippagePct: number) -> {entryTime, entryPrice} | null` — first candle with `time >= decidedAt`; `entryPrice = open * (1 ± slippagePct/100)` (long `+`, short `-`).
  - `positionSize({ equity, riskPct, entry, sl, maxLeverage = 1 }) -> { size, riskAmount }` — `riskAmount = equity*riskPct/100`, `size = riskAmount / |entry - sl|`, capped so `size*entry <= equity*maxLeverage` (then `riskAmount = size*|entry-sl|`).
  - `settleTrade(trade: Trade, candles: Candle[], ms: number, asOf: number, { feePct, slippagePct, forceClose = false }) -> Trade` — walks candles with `time >= trade.entryTime` and `time + ms <= asOf`. Per candle, long: gap (`open <= sl`) → exit at open, status `sl`; else `low <= sl` → exit `sl*(1 - slip)`, status `sl` (checked before TP so same-candle ⇒ SL); else `high >= tp` → exit `tp`, status `tp`. Shorts mirrored. Timeout: first candle where `time + ms >= entryTime + maxHoldHours*3600000` and no hit → exit at `close`, status `timeout`. `forceClose` and still open → exit at last candle close, status `end`. Otherwise stays `status: 'open'`. On exit sets `exitTime` (= the hit candle's `time` for gap exits at its open, otherwise the hit candle's `time + ms`; intrabar order is unknown, so close time is the conservative stamp), `exitPrice`, `fees = feePct/100*(entry+exit)*size`, `pnl` (gross − fees), `pnlPct = pnl/(entry*size)*100`, `r = pnl/riskAmount`.
- `Trade` fields: `id, step, decidedAt, side, entryTime, entryPrice, sl, tp, maxHoldHours, size, riskAmount, rationale, status, exitTime?, exitPrice?, fees?, pnl?, pnlPct?, r?`.
- Produces in `stats.js`: `summarize(trades: Trade[], { initialCapital }) -> { totalTrades, wins, losses, winRate, netPnl, netPnlPct, profitFactor, expectancyR, avgR, maxDrawdownPct, avgHoldHours, bestTrade, worstTrade, longs, shorts, finalEquity }` over closed trades (`status !== 'open'`) ordered by `exitTime`; rounding 2 decimals; zero trades → all `0` except `profitFactor: null`, `finalEquity: initialCapital`; no losses → `profitFactor: null`.

- [ ] **Step 1: Write failing tests** (hourly candles, `ms = 3600000`, `feePct 0`, `slippagePct 0` unless stated; long entry 100, sl 95, tp 110, equity 1000, risk 1 % → `size 2`, `riskAmount 10`):
  - candle `{open 100, high 111, low 99}` → `status 'tp'`, `exitPrice 110`, `pnl 20`, `r 2`.
  - same candle `{high 111, low 94}` → `status 'sl'`, `exitPrice 95`, `pnl -10`, `r -1`.
  - gap candle `{open 93}` → `exitPrice 93`, `pnl -14`, `r -1.4`.
  - short entry 100, sl 105, tp 90, candle `{low 89, high 101}` → `status 'tp'`, `exitPrice 90`, `pnl 20`.
  - `feePct 0.1`, tp case → `fees 0.42`, `pnl 19.58`.
  - `maxHoldHours 2`, flat candles → `status 'timeout'` at the candle where `time + ms >= entryTime + 2h`, exit at its close.
  - `asOf` earlier than the hit candle's close → trade stays `'open'` (no future leakage); same call with `forceClose: true` → `status 'end'`.
  - `fillEntry` long open 100, slip 0.05 → `100.05`; short → `99.95`; no candle at/after `decidedAt` → `null`.
  - `positionSize({equity:1000, riskPct:1, entry:100, sl:99.9})` → `size 10`.
  - `summarize` with pnl `[20,-10,-10,30]`, r `[2,-1,-1,3]`, capital 1000 → `netPnl 30`, `winRate 50`, `profitFactor 2.5`, `expectancyR 0.75`, `maxDrawdownPct 1.96`, `finalEquity 1030`; empty array → `totalTrades 0`, `winRate 0`, `maxDrawdownPct 0`, `profitFactor null`, no `NaN` anywhere (`JSON.stringify` contains no `null` except `profitFactor`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: backtest settlement and stats`.

### Task 10: Backtest session — persistence, blind steps, decisions

**Files:**
- Create: `src/backtest/session.js`, `src/backtest/snapshot.js`
- Test: `tests/backtestSession.test.js`

**Interfaces:**
- Produces in `snapshot.js`: `compactSnapshot(out: ComputeOutput) -> object` keeping only `candle, close, trend{state, ema, adx.adx, adx.strong, supertrend.dir, ichimoku.priceVsCloud}, momentum{rsi14, macd.hist, stochRsi, divergence}, volatility{atr14, atrPct, bollinger.pctB, squeeze}, volume{ratio}, levels{supports, resistances, structure}, breakout{up, down, falseBreakUp, falseBreakDown, retestUp, retestDown, volumeConfirmed}, patterns` (JSON ≤ 2500 chars per timeframe on a typical output); no `meta.dataAgeSec`.
- Produces in `session.js` (state persisted at `backtests/<runId>/state.json`, candles at `backtests/<runId>/candles-<tf>.json`; base dir overridable via `opts.dir` for tests):
  - `createRun(ex, opts: { exchange, symbol, days = 30, stepHours = 4, timeframes = ['1h','4h','1d'], baseTimeframe = '1h', maxHoldHours = 48, feePct = 0.1, slippagePct = 0.05, initialCapital = 1000, riskPct = 1, endTime = Date.now(), dir? }) -> Promise<{ runId, totalSteps, startTime, stepMs }>` — fetches, per timeframe, candles from `start - 250*tfMs` to `endTime`; aligns `start` to a `stepMs` boundary; throws (and writes nothing) if base candles in range `< 30`.
  - `getStep(runId, dir?) -> Promise<StepPayload | {done: true}>` — idempotent; `StepPayload = { runId, stepIndex, totalSteps, asOf: ISO, equity, position: null | {side, entryTime, entryPrice, sl, tp}, lastClosedTrade: Trade | null, snapshots: {[tf]: compactSnapshot}, instructions: string }`. Snapshots computed via `compute(sliceAsOf(rows, ms, t), { ms, prevDaily })` with `prevDaily` = last `1d`-closed candle as of `t`; `instructions = renderTemplate('analysis', {outputStyle:'keputusan', vars}).text` plus one line stating whether a position is open (then only `none` is accepted).
  - `submitDecision(runId, stepIndex, decision: {action, sl?, tp?, maxHoldHours?, rationale}, dir?) -> {accepted: true, nextStep: number | null} | {accepted: false, reason: string}` — rejects: `stepIndex !== state.currentStep`; action not in `long|short|none`; non-`none` while a position is open as of `t`; `long` unless `sl < lastClose < tp`, `short` unless `tp < lastClose < sl` (`lastClose` = last base-tf close as of `t`), non-finite numbers; rejection leaves state untouched. Accepted non-`none`: `fillEntry` on base candles, `positionSize` with current equity, push Trade; always push to `decisions` and advance `currentStep`.
  - `getRunStatus(runId, dir?) -> {runId, currentStep, totalSteps, decisions: number, trades: number, done: boolean}`.
- Position open "as of t" = `settleTrade(trade, base, baseMs, t, ...)` returns `status 'open'`.
- Consumes: Tasks 3, 8, 9, existing `compute`.

- [ ] **Step 1: Write failing tests** with a fake `ex` (synthetic hourly series 2000 rows with a **sentinel**: all candles after the decision time have `high = 999999`):
  - No lookahead: for every step `k`, `JSON.stringify(getStep(...))` never contains `999999`, and `snapshots['1h'].candle` ≤ `asOf`; snapshot equals `compactSnapshot(compute(sliceAsOf(...)))`.
  - `getStep` called twice returns the same `stepIndex`; `submitDecision` with the wrong `stepIndex` → `{accepted:false}` and `getRunStatus().currentStep` unchanged; resubmitting the same step is rejected.
  - Invalid levels: long with `sl >= lastClose`, long with `tp <= lastClose`, short mirrored, `sl: NaN`, missing `sl` → all rejected.
  - `none` at every step for all steps → `getStep` returns `{done:true}` at the end and `trades === 0`.
  - Open position blocks a new `long` until `settleTrade` as of `t` is closed; `lastClosedTrade` appears in a later step payload once closed.
  - Resume: after `submitDecision` on step 0, simulate restart by calling `getStep` with a fresh module state (read only from disk) → `stepIndex === 1`.
  - `createRun` with an `ex` returning `< 30` base candles rejects and leaves no directory under `dir`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both files (sync `node:fs` for state; write state atomically via temp file + rename). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: blind-forward backtest session`.

### Task 11: Excel export and `finishRun`

**Files:**
- Create: `src/backtest/excel.js`
- Modify: `src/backtest/session.js` (add `finishRun`), `package.json` (add `exceljs`)
- Test: `tests/backtestExcel.test.js`

**Interfaces:**
- Produces: `writeReport(path: string, { params, summary, trades, decisions }) -> Promise<void>` — sheets `Summary` (params block then all `summary` keys, one `label | value` row each), `Trades` (header row: `#, Decision (UTC), Side, Entry (UTC), Entry (WIB), Entry Price, SL, TP, Exit (UTC), Exit (WIB), Exit Reason, Exit Price, Hold (h), Size, Fees, P/L, P/L %, R, Equity After, Rationale`; one row per trade, closed or not), `Decisions` (`Step, Time (UTC), Action, Rationale`, one row per step including `none`).
- `finishRun(runId, dir?) -> Promise<{ summary, trades: Trade[], xlsxPath: string, tradesPath: string }>` — settles every open trade with `forceClose: true` (last base candle of the run), computes `summarize`, writes `backtests/<runId>/report.xlsx` and `trades.json`.
- Consumes: Tasks 9–10.

- [ ] **Step 1: Write failing tests**: `writeReport` into a temp dir then read back with `exceljs`: sheet names equal `['Summary','Trades','Decisions']`; `Trades` has `trades.length + 1` rows and header cell A1 `#`; `Summary` contains a row labelled `winRate` with the summary value; zero trades → file still written, `Trades` has 1 row (header only). `finishRun` on a run with one forced `end` trade → `summary.totalTrades === 1`, `xlsxPath` exists.
- [ ] **Step 2: Run** → FAIL. **Step 3: `npm install exceljs`**, implement. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: backtest excel report and finishRun`.

### Task 12: Backtest MCP tools and Backtest template

**Files:**
- Create: `src/tools/backtest.js`
- Modify: `prompts/backtest.md` (replace stub), `src/server.js`, `CLAUDE.md` (loop protocol section)
- Test: `tests/backtestTools.test.js`

**Interfaces:**
- Tools (register via `registerBacktestTools(server)`): `backtest_start({exchange, symbol, days?, step_hours?, timeframes?, max_hold_hours?, fee_pct?, slippage_pct?, initial_capital?, risk_pct?})` → `{runId, totalSteps, nextAction: 'call backtest_step'}`; `backtest_step({run_id})` → `StepPayload` or `{done: true, nextAction: 'call backtest_finish'}`; `backtest_decide({run_id, step_index, action, sl?, tp?, max_hold_hours?, rationale})` → `submitDecision` result; `backtest_status({run_id})`; `backtest_finish({run_id})` → `{summary, trades (compact rows: id, side, entryTime, entryPrice, sl, tp, exitTime, exitPrice, status, pnl, pnlPct, r), xlsxPath}`. Handlers are exported as plain async functions (`handlers.start`, …) so tests call them without MCP transport.
- `prompts/backtest.md` (`id: backtest`, triggers `backtest`, `uji mundur`; vars `symbol` required, `days` default `30`, `step_hours` default `4`, `exchange` default `tokocrypto`, `risk_pct` default `1`; input styles `cepat` (symbol+days), `kustom` (adds step, timeframes, fee, slippage, risk, max hold); output styles `ringkasan` (summary table only), `lengkap` (markdown trade list: #, side, entry time/price, SL, TP, exit time/price/reason, P/L, R + summary), `excel` (path to `report.xlsx` + 5-line summary)). `instruksi` must contain the loop protocol: `backtest_start` → repeat {`backtest_step`; follow the returned `instructions` verbatim; `backtest_decide` with the JSON only} until `done` → `backtest_finish`; never fetch other market data tools during a run; never guess outcomes; if context grows large, stop and tell the user the `run_id` so it can be resumed with `backtest_status`.

- [ ] **Step 1: Write failing tests** (fake `ex` as in Task 10): full loop via handlers over a short run (`days: 2`, `step_hours: 12`, 4 steps) with a scripted decision list `[long, none, none, none]` → `finish` returns `trades.length === 1`, `xlsxPath` exists, `summary.totalTrades === 1`; `decide` with the wrong `step_index` returns `accepted:false`; render `backtest` template for all style combos with sample vars → no leftover placeholders, `lengkap` mentions `TP`, `SL`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** tools and fill the template + `CLAUDE.md` loop section. **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: backtest tools and template`.

### Task 13: Docs and end-to-end verification

**Files:**
- Modify: `README.md`, `mcp.config.example.json`
- Test: manual verification only (no new test file)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update `README.md`**: tool table (add `get_indicators`, `list_prompt_templates`, `get_prompt_template`, `backtest_*`), env var names (`TOKOCRYPTO_*`, `TRADING_LIVE`, `MAX_ORDER_NOTIONAL`, `ALLOWED_SYMBOLS`), Safety section rewritten (guard semantics; `confirm` is not a guard; recommend client-side approval for `create_order`), a "Prompt templates" section (file format, styles, routing examples: "analisa BTC/USDT", "vwap 1 bulan ADA/USDT"), a "Backtest" section (blind-forward model, defaults, limitations from Decisions, output files), and fix absolute-path examples to `<project-path>`.
- [ ] **Step 2: Run** `npm test` → all PASS; `node scripts/indicators.js --test` → `self-test OK`.
- [ ] **Step 3: Start check**: `node src/index.js` starts and prints `trading-mcp server running on stdio` on stderr; list tools via `npm run inspect` (or send an MCP `tools/list`) and confirm `get_indicators`, `get_prompt_template`, `backtest_start` appear.
- [ ] **Step 4: Live smoke (needs network and user OK)**: `node scripts/indicators.js ADA/USDT --exchange tokocrypto --tf 1h --days 30 --only vwap` returns a `vwap.value`; a 2-day, 12-hour-step `backtest_start` on a public pair completes `getStep` once with no future data. Report results; do not place any order.
- [ ] **Step 5: Commit** `docs: readme for tools, templates, backtest, safety`.
