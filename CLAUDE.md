# Data trading BTC/ETH/HYPE (1 Jan - 18 Okt 2026)

- `node collect.js` menarik candle 15m, membuat 1h dan 4h, menghitung indikator, menulis CSV.
  - Default: Binance USDT-M futures ke `data/<COIN>USDT_<tf>.csv`.
  - `SOURCE=tokocrypto`: spot Tokocrypto ke `data/tokocrypto/`. `COINS=BTC` membatasi koin.
- Indikator per file: EMA20/50/200/800, RSI14, ATR14, VWAP harian, rasio volume, ADX14 (+DI/-DI), MACD, Bollinger, Donchian 1 hari, trend, regime.
- Strategi BTC: `node strategy.js [fee] [delay15m]` -> tabel bulanan + `TRADES.xlsx`; `PROFILE=aktif` (~13 trade/bulan, utama + A2 risiko 1%), `FROM/TO` untuk jendela; aturan di `TRADEPLAN.md` (in-sample saja). Snapshot v1 di `backup/`, profil aktif (disetujui user) di `backup/aktif/`.
- Semua angka harus dari `data/`; jangan mengarang angka.
- Kode strategi lama ada di branch `backup/pre-reset` (hanya reset pertama); strategi/studi setelahnya sudah dihapus atas permintaan.
