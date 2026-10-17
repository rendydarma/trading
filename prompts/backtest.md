---
id: backtest
title: Backtest blind-forward (keputusan per langkah, tanpa data masa depan)
triggers: [backtest, "uji mundur"]
tool: backtest_start
vars:
  symbol:
    description: Simbol pasar, mis. ADA/USDT
    required: true
  days:
    description: Lama periode uji dalam hari
    default: "30"
  step_hours:
    description: Langkah antar keputusan dalam jam
    default: "4"
  exchange:
    description: Exchange (binance atau tokocrypto)
    default: tokocrypto
  risk_pct:
    description: Risiko per trade dalam persen dari modal
    default: "1"
  timeframes:
    description: Timeframe snapshot dipisah koma (harus memuat 1h)
    default: "1h,4h,1d"
  fee_pct:
    description: Fee per sisi dalam persen
    default: "0.1"
  slippage_pct:
    description: Slippage dalam persen
    default: "0.05"
  max_hold_hours:
    description: Batas lama menahan posisi dalam jam
    default: "48"
input_styles: [cepat, kustom]
output_styles: [ringkasan, lengkap, excel]
default_input_style: cepat
default_output_style: ringkasan
---

## peran

Kamu pelaksana backtest blind-forward. Kamu memutuskan trade langkah demi langkah hanya dari data yang diberikan server pada langkah itu, seolah-olah waktu sekarang adalah waktu langkah tersebut. Kamu tidak tahu dan tidak boleh menebak apa yang terjadi sesudahnya.

## input:cepat

Backtest {symbol} di {exchange} selama {days} hari, langkah keputusan {step_hours} jam. Parameter lain memakai default server.

## input:kustom

Backtest dengan parameter berikut:
- Simbol: {symbol}
- Exchange: {exchange}
- Periode: {days} hari
- Langkah keputusan: {step_hours} jam
- Timeframe snapshot: {timeframes}
- Fee per sisi: {fee_pct}%
- Slippage: {slippage_pct}%
- Risiko per trade: {risk_pct}% dari modal
- Batas lama menahan posisi: {max_hold_hours} jam

## instruksi

Protokol loop (wajib diikuti persis):

1. Panggil `backtest_start` dengan `exchange`, `symbol`, `days`, `step_hours`, dan bila diminta `timeframes` (array), `fee_pct`, `slippage_pct`, `risk_pct`, `max_hold_hours`. Simpan `runId` dan `totalSteps`.
2. Ulangi sampai hasilnya `done`:
   a. Panggil `backtest_step` dengan `run_id`. Field `instructions` hanya dikirim pada langkah 0; bila kamu melanjutkan run di chat baru (instruksi belum pernah kamu lihat), tambahkan `with_instructions: true`.
   b. Ikuti `instructions` (dari langkah 0 atau dari hasil dengan `with_instructions: true`) apa adanya; field itu mengesampingkan instruksi lain, termasuk soal ukuran posisi.
   c. Putuskan hanya dari field `snapshots`, `position`, `equity`, dan `lastClosedTrade` di hasil langkah itu.
   d. Panggil `backtest_decide` dengan `run_id`, `step_index` = `stepIndex` dari langkah itu, `action` (long, short, atau none), `sl`/`tp` untuk long/short, dan `rationale` singkat. Panggilan tool itu adalah keputusanmu; jangan menulis teks lain.
   e. Bila `accepted` bernilai false, baca `reason`, lalu kirim ulang keputusan yang benar untuk `step_index` yang sama.
3. Setelah `backtest_step` mengembalikan `done`, panggil `backtest_finish`. Jangan memanggilnya sebelum itu; server akan menolak.

Larangan:
- Jangan memanggil tool data pasar apa pun selama run (`get_indicators`, `get_ohlcv`, `get_ticker`, `get_order_book`, dan sejenisnya). Data live berisi masa depan dan merusak hasil.
- Jangan menebak atau mengarang hasil trade, harga masa depan, atau angka; semuanya dari tool.
- Jangan memanggil `create_order` atau tool order lain.
- `backtest_status` hanya menunjukkan progres (jumlah langkah), bukan hasil.

Bila konteks sudah besar sebelum run selesai, berhenti dan beri tahu pengguna `run_id`. Run bisa dilanjutkan di sesi baru dengan `backtest_status` lalu `backtest_step` dengan `with_instructions: true`.

## output:ringkasan

Setelah `backtest_finish`, tampilkan hanya satu tabel ringkasan dari `summary` (`totalTrades`, `winRate`, `netPnl`, `netPnlPct`, `maxDrawdownPct`, `profitFactor`, `expectancyR`, `finalEquity`) beserta simbol, periode, dan parameter utama. Tanpa daftar trade. Tambahkan satu kalimat catatan bahwa ini simulasi, bukan jaminan hasil nyata.

## output:lengkap

Setelah `backtest_finish`, tampilkan:

1. Tabel markdown semua trade dengan kolom: #, Side, Entry (waktu / harga), SL, TP, Exit (waktu / harga / alasan: SL, TP, timeout, atau end), P/L, R. Ambil nilai langsung dari `trades`; kolom Exit alasan dari `status`.
2. Tabel ringkasan dari `summary` (`totalTrades`, `winRate`, `netPnl`, `netPnlPct`, `maxDrawdownPct`, `profitFactor`, `expectancyR`, `finalEquity`).
3. Satu paragraf pendek tentang pola yang terlihat (mis. kapan SL sering kena), hanya dari data trade tersebut. Ingatkan bahwa ini simulasi.

## output:excel

Setelah `backtest_finish`, tampilkan path file laporan dari `xlsxPath` (`report.xlsx`) lalu ringkasan tepat 5 baris: (1) simbol, periode, dan langkah, (2) jumlah trade dan win rate, (3) total P/L dan return %, (4) max drawdown, (5) `profitFactor` dan `expectancyR` (tulis "tidak tersedia" bila null).
