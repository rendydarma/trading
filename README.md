# trading-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes **Tokocrypto** and **Binance** market data, technical indicators, prompt templates, blind-forward backtesting and (guarded) trading via the [ccxt](https://github.com/ccxt/ccxt) library.

Requires **Node.js >= 21**.

## Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `list_exchanges` | no | List configured exchanges and whether credentials are set |
| `get_ticker` | no | Latest price ticker for a symbol |
| `get_order_book` | no | Current bids/asks |
| `get_ohlcv` | no | Historical candles (`since` without `limit` returns at most 1000 rows) |
| `get_markets` | no | List/filter available markets |
| `get_indicators` | no | Technical-analysis report from closed candles (trend, momentum, volatility, volume, levels, breakout, patterns, anchored VWAP, multi-timeframe alignment) |
| `list_prompt_templates` | no | List the prompt templates with triggers, variables and styles |
| `get_prompt_template` | no | Render a prompt template by `id`, or route the user's raw text to one |
| `backtest_start` | no | Start a blind-forward backtest run; returns `runId` and `totalSteps` |
| `backtest_step` | no | Snapshot for the current step (or `{done: true}`); `instructions` only at step 0 or with `with_instructions: true` |
| `backtest_decide` | no | Submit the decision (`long`/`short`/`none`, `sl`, `tp`) for the current step |
| `backtest_status` | no | Progress of a run (step counts only, no results); use it to resume |
| `backtest_finish` | no | Write `report.xlsx` and `trades.json`, return summary and trades (refused until all steps are decided) |
| `get_balance` | yes | Account balances |
| `get_open_orders` | yes | Open orders |
| `get_my_trades` | yes | Filled trade history |
| `create_order` | yes | Place a live order (fail-closed, see [Safety](#safety)) |
| `cancel_order` | yes | Cancel an order by id |
| `reload_config` | no | Clear cached exchange clients only; env/`.env` changes need a server restart |

Symbols use the ccxt unified format, e.g. `BTC/USDT` (Binance) or `BTC/IDR` (Tokocrypto).

## Install

```powershell
cd <project-path>
npm install
```

## Configure credentials

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in your keys. Credentials are read from the environment, never hard-coded. The server loads the `.env` in the repository root (resolved from the module location, not the client's working directory).

| Variable | Purpose |
| --- | --- |
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | Binance credentials |
| `BINANCE_SANDBOX` | `true` to use the Binance Spot Testnet (needs testnet keys) |
| `BINANCE_DEFAULT_TYPE` | `spot` (default), `future`, `margin`, `delivery` |
| `TOKOCRYPTO_API_KEY`, `TOKOCRYPTO_API_SECRET` | Tokocrypto credentials |
| `TOKOCRYPTO_SANDBOX` | Must stay unset/`false`: ccxt has no Tokocrypto sandbox and `true` throws |
| `TRADING_LIVE` | Must be `true` for `create_order` to submit anything |
| `MAX_ORDER_NOTIONAL` | Required positive number: maximum order value, expressed in the `MAX_ORDER_QUOTE` currency |
| `MAX_ORDER_QUOTE` | Required quote currency the cap is expressed in, e.g. `USDT`; orders on markets with another quote are blocked |
| `ALLOWED_SYMBOLS` | Optional comma-separated allowlist, e.g. `BTC/USDT,ETH/USDT` |

`reload_config` only clears cached exchange clients. Changes to `.env` or the environment (`TRADING_LIVE`, `MAX_ORDER_NOTIONAL`, `MAX_ORDER_QUOTE`, `ALLOWED_SYMBOLS`, API keys) are not re-read: restart the MCP server to apply them.

The legacy misspelled `TOKOCYPTO_*` names (`_API_KEY`, `_API_SECRET`, `_SANDBOX`) are still read as a fallback; `TOKOCRYPTO_*` takes precedence.

- **Binance**: create keys at https://www.binance.com/en/my/settings/api-management
- **Tokocrypto**: enable the Trade API from the Tokocrypto website.

Market-data tools, `get_indicators`, templates and backtests need no credentials.

## Run

```powershell
npm start
```

The server speaks MCP over stdio (logs go to stderr, stdout carries only protocol messages). For a quick manual test:

```powershell
npm run inspect
```

## Register with an MCP client

Add a block like `mcp.config.example.json` to your client config (Claude Desktop, opencode, etc.). For opencode it goes in `opencode.json` under `mcp`:

```json
{
  "mcp": {
    "trading": {
      "type": "local",
      "command": ["node", "<project-path>/src/index.js"],
      "environment": {
        "BINANCE_API_KEY": "…",
        "BINANCE_API_SECRET": "…",
        "TOKOCRYPTO_API_KEY": "…",
        "TOKOCRYPTO_API_SECRET": "…"
      }
    }
  }
}
```

Replace `<project-path>` with the absolute path of this repository. Do not add `TRADING_LIVE=true` to a client config unless you really intend to let the model place orders.

## Safety

`create_order` is **fail-closed**. Calling it never sends a real order unless the server is explicitly configured to allow it:

- `TRADING_LIVE=true` is required. Otherwise the order is blocked.
- `MAX_ORDER_NOTIONAL` must be set to a positive number. If it is missing or invalid the order is blocked; an order above the cap is blocked.
- `MAX_ORDER_QUOTE` must be set (e.g. `USDT`) and equal to the market's quote currency (case-insensitive); otherwise the order is blocked. The cap is a single number, so it is only meaningful in one currency: a `BTC/IDR` order is refused when the cap is in `USDT`.
- `ALLOWED_SYMBOLS` (optional): when set, only listed symbols are accepted. A set value that parses to nothing blocks every symbol.
- The order must also respect the exchange minimum notional, and a limit order needs a valid price.

How the notional cap is computed: `amount * price`, where the price comes from the **ticker `last` price**. A limit order uses `max(limit price, last)`. A market order uses `last` only, so a market order can still slip past the cap if the price moves before it fills.

The `confirm` parameter is **set by the model and is not a safety guard**. With `confirm=false` (default) the order is only previewed; with `confirm=true` the server still applies the checks above. Do not rely on `confirm` to keep a model from trading.

Recommendations:

- Require **client-side approval** (manual tool approval in your MCP client) for `create_order` and `cancel_order`. `cancel_order` is intentionally not gated by `TRADING_LIVE` (cancelling reduces exposure), so client-side approval is the only control on it.
- Leave `TRADING_LIVE` unset/`false` unless you intend to trade, and pick a small `MAX_ORDER_NOTIONAL`.
- Binance: you can run against the Spot **Testnet** with `BINANCE_SANDBOX=true` and testnet keys.
- Tokocrypto has **no sandbox** in ccxt; setting `TOKOCRYPTO_SANDBOX=true` makes the exchange client throw instead of silently trading live.
- Grant API keys only the permissions you need (read for data tools, trade only if you intend to trade). Never enable withdrawals unless strictly required.
- Keep `.env` out of version control (already in `.gitignore`).

## Prompt templates

Templates are Markdown files in `prompts/`. The server exposes them through `list_prompt_templates`, `get_prompt_template` and as MCP prompts (one per template id).

### File format

Each file starts with YAML frontmatter:

| Field | Meaning |
| --- | --- |
| `id`, `title` | Template id and display title |
| `triggers` | Words that route a user message to this template |
| `tool`, `script` | Hints returned with the template: the MCP tool to call, and the equivalent CLI command |
| `vars` | Variables with `description`, optional `default`, optional `required: true` |
| `input_styles`, `output_styles` | Allowed styles, plus `default_input_style` / `default_output_style` |

The body is split into `## ` sections: `peran` (role), `instruksi` (instructions), `input:<style>` (how the request is phrased) and `output:<style>` (how the answer is formatted). `{var}` placeholders are filled from `vars`; a missing required variable (e.g. `symbol`) is reported so the agent can ask the user.

### Shipped templates

| Id | Purpose | Input styles | Output styles |
| --- | --- | --- | --- |
| `analysis` | Multi-timeframe technical analysis with a trade plan and "do not trade" checks | `ringkas` (default), `lengkap` | `ringkas` (default), `detail`, `json`, `keputusan` |
| `indicator` | Report specific indicators from `get_indicators` | `cepat` (default), `periode` | `tabel` (default), `narasi`, `json` |
| `backtest` | Run the blind-forward backtest loop | `cepat` (default), `kustom` | `ringkasan` (default), `lengkap`, `excel` |

The `keputusan` output style of `analysis` is the strict JSON decision (`action`, `sl`, `tp`, `maxHoldHours`, `rationale`) that the backtest uses at each step.

### Routing

`CLAUDE.md` tells the agent to call `get_prompt_template` with the user's raw message as `text` for every trading request. The server matches the `triggers` of each template (priority backtest > analysis > indicator) and returns the rendered instructions plus `Tool:` / `Script:` hints. Pass `id` to skip routing. `vars` values may be strings or numbers. Routing only picks the template; the agent extracts variables from the message and passes them as `vars` (a missing required one, such as `symbol`, makes the call fail so the agent asks the user). Examples:

- `analisa BTC/USDT` routes to `analysis` with `vars={"symbol":"BTC/USDT"}` (defaults: `tokocrypto`, timeframes `15m,1h,1d`, horizon `intraday`, risk 1%, minimum reward:risk `min_rr` 1.5).
- `vwap 1 bulan ADA/USDT` routes to `indicator` with `vars={"symbol":"ADA/USDT","indicator":"vwap","days":"30"}`, and the `Script:` hint becomes
  `node scripts/indicators.js ADA/USDT --exchange tokocrypto --tf 1h --days 30 --only vwap --vwap-anchor period`.
- `backtest ADA/USDT 30 hari` routes to `backtest` with `vars={"symbol":"ADA/USDT","days":"30"}`.

For the `indicator` template the `--only` value must be an indicator **section** name (`trend`, `momentum`, `volatility`, `volume`, `levels`, `breakout`, `patterns`, `vwap`), not an individual indicator. The alias table in `prompts/indicator.md` maps requests to sections, for example `rsi`, `macd`, `stoch` -> `momentum`; `ema`, `sma`, `adx`, `supertrend`, `ichimoku` -> `trend`; `atr`, `bollinger` -> `volatility`; `obv` -> `volume`; `fibonacci`, `pivot` -> `levels`.

## Indicators CLI

Public data only (no API key); closed candles only (the in-progress candle is dropped).

```powershell
node scripts/indicators.js <SYMBOL> [--exchange tokocrypto|binance] [--tf 15m,1h,1d] [--days N]
  [--only trend,momentum,volatility,volume,levels,breakout,patterns,vwap]
  [--vwap-anchor day|week|month|period] [--format table|json] [--history N] [--out file] [--limit 1000]
node scripts/indicators.js --test      # pure-function self-test, prints "self-test OK"
```

- `--days N` sets the look-back window (VWAP is computed over it; EMA warm-up candles are added automatically).
- `--vwap-anchor` defaults to `period` (start of the window).
- `--format` defaults to `json`; `table` is a compact view and is ignored when `--only` is used.
- `--history N` prints the last N rows of the key series as CSV, one block per timeframe.
- `--out file` also saves the output to a file.
- The same report is available to agents as the `get_indicators` tool (`vwap_anchor`, `only` as array).

Example: `node scripts/indicators.js ADA/USDT --exchange binance --tf 1h --days 30 --only vwap`

## Backtest

A blind-forward backtest lets the model trade a recent window one decision at a time, without ever seeing the future.

**Model.** `backtest_start` downloads candles once and stores them on disk. At each decision time `t` the model sees only candles that had **closed by `t`** (indicator snapshots per timeframe, current position, equity, last closed trade). The server holds the future candles and settles trades itself, so the model cannot peek. Everything lives on disk, so a run survives a server restart.

**Loop protocol** (also in `prompts/backtest.md` and `CLAUDE.md`):

1. `backtest_start` -> keep `runId` and `totalSteps`.
2. Repeat until `done`: `backtest_step`, follow its `instructions` as given (sent at step 0 only; pass `with_instructions: true` when resuming in a new chat), then `backtest_decide` with `step_index` = `stepIndex` and the decision params (`action`, `sl`, `tp`, `max_hold_hours`, `rationale`); no other text. If `accepted` is `false`, fix the decision for the same step using `reason`.
3. When `backtest_step` returns `done`, call `backtest_finish`. It is **refused until all steps are decided** (it would otherwise reveal future outcomes).

During a run the model must not call market-data tools (`get_indicators`, `get_ohlcv`, `get_ticker`, ...) and must not place orders.

**Defaults** (`backtest_start` arguments, all optional except `exchange` and `symbol`):

| Parameter | Default |
| --- | --- |
| `days` | 30 |
| `step_hours` | 4 (must be a whole multiple of the base timeframe, 1h) |
| `timeframes` | `["1h","4h","1d"]` (must include `1h`, the base timeframe) |
| `max_hold_hours` | 48 |
| `fee_pct` | 0.1 per side |
| `slippage_pct` | 0.05 |
| `initial_capital` | 1000 |
| `risk_pct` | 1 (percent of equity per trade) |

**Trading rules.**

- Entries are market orders filled at the **open of the base (1h) candle at decision time**, adjusted by slippage; if no candle opens exactly then, the decision is recorded as skipped.
- Position size is set by the server from `risk_pct`, the entry-to-SL distance and equity (no leverage; size is capped at equity / entry).
- Fee is charged per side; slippage applies to entries and stop-loss fills.
- **One position at a time.** While a position is open only `none` is accepted.
- If SL and TP are both touched in the same candle, **SL wins**. A gap through SL fills at the open. Trades also close on timeout (`max_hold_hours`, capped by the run limit) or at the end of the run.
- A long needs `sl < last close < tp`; a short needs `tp < last close < sl`.

**Output** (git-ignored `backtests/<runId>/`):

- `state.json`: run parameters, decisions and trades (the resume point)
- `candles-<tf>.json`: stored candles per timeframe
- `trades.json`: settled trades (written by `backtest_finish`)
- `report.xlsx`: sheets **Summary** (parameters and statistics), **Trades** and **Decisions**

`backtest_status` reports progress only; resume a run in a new chat with `backtest_status` and then `backtest_step` using the `run_id` and `with_instructions: true`. `backtest_*` tools return compact (single-line) JSON.

**Known limitations.**

- The model may remember real historical prices from its training data, which leaks the future. Use recent windows (after the model's knowledge cutoff) for credible results.
- About 180 steps (30 days at 4h) in one chat grows the context a lot. If the context fills up, stop and resume with `backtest_status` / `backtest_step` using the `run_id`.
- Entries are market orders at the open of the base candle at decision time; limit-order entries are not simulated.
- The server does **not** enforce that the model avoids `get_ohlcv`, `get_indicators`, `get_ticker` and `get_order_book` during a backtest; this is prompt-only. Any live call can reveal data after the decision time.
- The default 30-day / 4h backtest is about 180 steps and each step payload is several KB. Use shorter windows (`days`, a larger `step_hours`) or resume in new chats.
- Results are a simulation, not trading advice or a promise of real performance.

## Tests

```powershell
npm test                  # node --test "tests/**/*.test.js"
npm run test:indicators   # indicators self-test
```

Tests use fake exchanges and temporary directories; they do not touch the network, credentials or place orders.

## Notes

- Built on ccxt, so the same code path works for both exchanges. Additional ccxt exchanges can be added by extending `EXCHANGE_REGISTRY` in `src/config.js`.
- This software is provided as-is for educational purposes; trading involves risk.
