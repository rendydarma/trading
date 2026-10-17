# Trading MCP: aturan agen

## Routing intent

Setiap permintaan trading dari pengguna: panggil tool `get_prompt_template` dengan `text` = pesan pengguna (dan `vars` bila simbol/parameter sudah jelas), lalu ikuti instruksi yang dikembalikan.

| Pesan mengandung | Template (`id`) |
|---|---|
| backtest, uji mundur | `backtest` |
| analisa, analisis, analyze | `analysis` |
| indikator, indicator, vwap, rsi, macd, ema, sma, atr, adx, bollinger, supertrend, ichimoku, stoch, cci, mfi, obv, fibonacci, pivot | `indicator` |

Prioritas bila beberapa cocok: backtest > analysis > indicator. Daftar lengkap: tool `list_prompt_templates`. Trigger dibaca dari frontmatter `prompts/*.md`.

## Aturan

- Panggil tool data (`get_indicators`, dll.) sebelum berpendapat; jangan pernah mengarang angka.
- Jangan pernah memanggil `create_order` tanpa persetujuan eksplisit pengguna pada giliran yang sama.
- Bila `get_prompt_template` menyebut variabel wajib yang hilang (mis. `symbol`), tanyakan ke pengguna.

## Backtest loop

Protokol backtest blind-forward (template `backtest`):

1. `backtest_start` -> simpan `runId`.
2. Ulangi sampai `done`: `backtest_step` (field `instructions` hanya ada di langkah 0; saat melanjutkan run di chat baru panggil dengan `with_instructions: true`); ikuti `instructions` apa adanya; `backtest_decide` dengan `step_index` = `stepIndex` dan param keputusan (`action`, `sl`, `tp`, `max_hold_hours`, `rationale`); tanpa teks lain.
3. Setelah `done`: `backtest_finish` (ditolak server bila belum selesai; jangan dipaksa).

Larangan: jangan panggil tool data pasar (`get_indicators`, `get_ohlcv`, dst.) selama run, jangan menebak hasil trade. Bila konteks membesar, berhenti dan beri tahu pengguna `run_id`; lanjutkan dengan `backtest_status` lalu `backtest_step` dengan `with_instructions: true`.
