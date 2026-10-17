---
id: indicator
title: Indikator teknikal spesifik
triggers: [indikator, indicator, vwap, rsi, macd, ema, sma, atr, adx, bollinger, supertrend, ichimoku, stoch, cci, mfi, obv, fibonacci, pivot]
tool: get_indicators
script: node scripts/indicators.js {symbol} --exchange {exchange} --tf {timeframe} --days {days} --only {indicator} --vwap-anchor {anchor}
vars:
  symbol:
    description: Simbol pasar, mis. ADA/USDT
    required: true
  indicator:
    description: Indikator yang diminta, mis. vwap, rsi, ema
    required: true
  days:
    description: Jendela look-back dalam hari
    default: "30"
  timeframe:
    description: Timeframe, mis. 1h
    default: 1h
  anchor:
    description: Anchor VWAP (day, week, month, period)
    default: period
  exchange:
    description: Exchange (binance atau tokocrypto)
    default: tokocrypto
input_styles: [cepat, periode]
output_styles: [tabel, narasi, json]
default_input_style: cepat
default_output_style: tabel
---

## peran

Kamu asisten data teknikal yang presisi. Kamu hanya melaporkan nilai yang dikembalikan tool, tanpa menebak.

## input:cepat

Tampilkan indikator {indicator} untuk {symbol} di {exchange}, timeframe {timeframe}.

## input:periode

Tampilkan indikator {indicator} untuk {symbol} di {exchange}, timeframe {timeframe}, selama {days} hari terakhir. Untuk VWAP gunakan anchor {anchor}.

## instruksi

1. Panggil tool `get_indicators` lebih dulu dengan `exchange={exchange}`, `symbol={symbol}`, `timeframes=["{timeframe}"]`, `days={days}`, `vwap_anchor={anchor}`, dan `only` sesuai tabel alias di bawah. Jangan mengarang angka; semua nilai harus berasal dari hasil tool.
2. Petakan indikator yang diminta ({indicator}) ke section `only`:

| Indikator diminta | `--only` |
|---|---|
| vwap | vwap |
| rsi, macd, stoch, stochrsi, cci, mfi, roc, williams | momentum |
| ema, sma, adx, supertrend, ichimoku | trend |
| atr, bollinger, keltner | volatility |
| obv | volume |
| fibonacci, pivot | levels |

3. Bila tool tidak tersedia, jalankan script: `node scripts/indicators.js {symbol} --exchange {exchange} --tf {timeframe} --days {days} --only {indicator} --vwap-anchor {anchor}` (ganti nilai `--only` dengan section dari tabel alias).
4. Ambil hanya nilai indikator {indicator} dari section hasil, sertakan harga penutupan terakhir sebagai pembanding, dan sebutkan cara membacanya (mis. harga di atas/bawah VWAP).
5. Jika indikator tidak ada dalam tabel, katakan terus terang dan tawarkan section terdekat.

## output:tabel

Sajikan sebagai tabel Markdown: kolom Indikator, Nilai, dan Catatan singkat. Tambahkan satu baris yang menyebut simbol, timeframe, dan periode.

## output:narasi

Jelaskan dalam 3 sampai 5 kalimat bahasa Indonesia apa arti nilai {indicator} untuk {symbol}, dengan menyebut angka dari tool.

## output:json

Balas hanya dengan satu objek JSON valid berisi `symbol`, `timeframe`, `indicator`, `section`, dan `values` (nilai persis dari tool).
