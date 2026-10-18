# Trade Plan BTCUSDT Perpetual (10x, modal 100 USDT)

Sumber angka: `node strategy.js` di atas `data/BTCUSDT_{15m,1h,4h}.csv` (1 Jan - 18 Okt 2026).
Semua hasil di bawah adalah **in-sample**: aturan dicari dan dicek di data yang sama.

## 1. Kontrak

| Item | Nilai | Sumber |
|---|---|---|
| Tokocrypto Futures | **Belum tersedia.** API Tokocrypto hanya punya pasar spot; berita 18 Sep 2026 menyebut futures (rencana 25x) masih disiapkan. | ccxt `tokocrypto.loadMarkets()`, akurat.co |
| Kontrak acuan | Binance USDT-M `BTCUSDT` perpetual (data `data/` juga dari sini) | ccxt `binanceusdm` |
| Qty min / step | 0.001 BTC / 0.001 BTC | filter LOT_SIZE |
| Notional min | 50 USDT | filter MIN_NOTIONAL |
| Tick harga | 0.1 | PRICE_FILTER |
| Fee | taker 0.05%, maker 0.02% | market info |
| Funding | tiap 8 jam, rata-rata +0.0027% (Jan-Okt 2026) | funding history |

Kalau Tokocrypto Futures sudah aktif, cek ulang qty min, notional min, fee, dan leverage maksimum sebelum memakai plan ini.

## 2. Setting akun

- Margin **isolated**, leverage **10x** (batas atas; ukuran posisi ditentukan oleh risiko, bukan leverage).
- Risiko per trade: **3% equity**. `qty = floor(equity x 0.03 / jarak_SL / 0.001) x 0.001`, dan notional maks `equity x 10`.
- Kalau qty < 0.001 atau notional < 50 USDT: **skip** trade.
- Hanya **1 posisi** terbuka. Sinyal baru diabaikan selama posisi masih jalan.
- Order masuk: market di open candle 15m pertama setelah candle 1h sinyal close. SL dan TP dipasang langsung.

## 3. Regime (dari candle 4h terakhir yang sudah close)

| Regime | Syarat |
|---|---|
| UP | EMA50 > EMA200 dan close > EMA200 |
| DOWN | EMA50 < EMA200 dan close < EMA200 |
| CAMPUR | selain itu |

Kekuatan trend = ADX14 4h. ADX >= 35: trend kuat. ADX < 15: tanpa trend (range).

| Kondisi pasar | Setup aktif |
|---|---|
| UP + ADX4h >= 35 | A Long, B Long |
| DOWN + ADX4h >= 35 | A Short, B Short |
| ADX4h < 15 (regime apa saja) | C Long, C Short |
| Lainnya | **Tidak trade** |

Semua sinyal dicek saat candle **1h close**. Urutan prioritas jika bentrok: A, lalu B, lalu C (Long dicek dulu).

## 4. Strategi A - Continuation (breakout)

| | LONG | SHORT |
|---|---|---|
| Regime | UP, ADX4h >= 35 | DOWN, ADX4h >= 35 |
| Trigger 1h | close > Donchian 24h high candle sebelumnya | close < Donchian 24h low candle sebelumnya |
| Volume | vol_ratio 1h >= 2.0 | vol_ratio 1h >= 2.0 |
| SL awal | entry - 2 x ATR14(1h) | entry + 2 x ATR14(1h) |
| TP | 3R | 3R |
| Trailing | tiap close 15m: SL = max(SL, close - 3 x ATR1h saat entry) | SL = min(SL, close + 3 x ATR1h saat entry) |
| Waktu maks | 72 jam, lalu tutup market | 72 jam |

## 5. Strategi B - Pullback (lanjut trend)

| | LONG | SHORT |
|---|---|---|
| Regime | UP, ADX4h >= 35 | DOWN, ADX4h >= 35 |
| Pullback | RSI14(1h) <= 40 minimal sekali di 8 candle 1h terakhir | RSI14(1h) >= 60 minimal sekali di 8 candle terakhir |
| Trigger | close 1h kembali **di atas** EMA20(1h), candle sebelumnya close di bawah/sama | close 1h kembali **di bawah** EMA20(1h), candle sebelumnya di atas/sama |
| SL | low terendah 8 candle 1h - 0.2 x ATR1h | high tertinggi 8 candle + 0.2 x ATR1h |
| Filter SL | jarak SL harus 0.5-4 x ATR1h, kalau di luar: skip | sama |
| TP | 2R | 2R |
| Waktu maks | 72 jam | 72 jam |

## 6. Strategi C - Reversal (hanya pasar tanpa trend)

| | LONG | SHORT |
|---|---|---|
| Regime | ADX4h < 15 | ADX4h < 15 |
| Candle sebelumnya | close < Bollinger lower dan RSI14 <= 30 | close > Bollinger upper dan RSI14 >= 70 |
| Trigger | candle 1h sekarang close kembali di atas Bollinger lower | close kembali di bawah Bollinger upper |
| SL | low terendah 3 candle 1h - 0.2 x ATR1h | high tertinggi 3 candle + 0.2 x ATR1h |
| Filter SL | 0.5-4 x ATR1h | sama |
| TP | 2R | 2R |
| Waktu maks | 24 jam | 24 jam |

Reversal **tidak** dipakai melawan trend kuat. Data menunjukkan fade di trend kuat rugi.

## 7. Checklist tiap candle 1h close

1. Ada posisi? Ya: kelola saja (SL, TP, trailing A, batas waktu). Selesai.
2. Baca candle 4h terakhir yang sudah close: regime dan ADX.
3. Cocokkan tabel bagian 3. Tidak ada setup aktif: tunggu.
4. Cek trigger A, lalu B, lalu C.
5. Hitung jarak SL, qty, notional. Skip jika qty < 0.001 atau notional < 50 USDT.
6. Entry market di open 15m berikutnya, pasang SL dan TP.

## 8. Hasil in-sample (1 Jan - 18 Okt 2026)

Simulasi di candle 15m, fee taker 0.05% per sisi, funding 0.01% per 8 jam dibebankan, SL menang jika SL dan TP kena di candle 15m yang sama.

| Bulan | Equity awal | Equity akhir | % |
|---|---|---|---|
| 2026-01 | 100.00 | 107.31 | +7.3 |
| 2026-02 | 107.31 | 131.44 | +22.5 |
| 2026-03 | 131.44 | 127.25 | -3.2 |
| 2026-04 | 127.25 | 135.86 | +6.8 |
| 2026-05 | 135.86 | 127.44 | -6.2 |
| 2026-06 | 127.44 | 149.98 | +17.7 |
| 2026-07 | 149.98 | 141.50 | -5.7 |
| 2026-08 | 141.50 | 163.65 | +15.7 |
| 2026-09 | 163.65 | 181.86 | +11.1 |
| 2026-10 (s/d 18) | 181.86 | 192.95 | +6.1 |

Total 100 -> 192.95 USDT, 42 trade, max drawdown 10.8%, losing streak terpanjang 4.

| Setup | Sisi | Trade | Menang | Total R |
|---|---|---|---|---|
| A Continuation | Long | 9 | 3 | +0.5 |
| A Continuation | Short | 9 | 5 | +11.1 |
| B Pullback | Long | 9 | 6 | +6.7 |
| B Pullback | Short | 8 | 4 | +2.4 |
| C Reversal | Long | 2 | 2 | +3.7 |
| C Reversal | Short | 5 | 3 | +2.9 |

Rata-rata menang +1.94R, rata-rata kalah -0.91R. Detail per trade: `TRADES.xlsx`.

### Target vs hasil

| Target | Hasil in-sample |
|---|---|
| >= 7/10 bulan profit | 7/10 |
| Bulan rugi > -10% | terburuk -6.2% |
| Bulan profit > 5% | semua bulan profit >= 6.1% |

### Uji ketahanan (aturan sama, `node strategy.js <fee> <delay>`)

| Skenario | Akhir | Bulan profit | Terburuk |
|---|---|---|---|
| Dasar | 192.95 | 7/10 | -6.2% |
| Fee 0.10%/sisi | 169.73 | 7/10 | -7.2% |
| Entry telat 15m | 179.87 | 7/10 | -6.0% |
| Entry telat 30m | 154.30 | 7/10 (2 bulan < 5%) | -5.7% |

Parameter digeser satu langkah (20 varian: ADX, volume, SL, TP, trailing, RSI, jendela): 17 tetap >= 7/10 bulan profit, dan 18 punya bulan terburuk di atas -10%. Tapi sebagian besar varian punya 1-3 bulan profit di bawah 5%. Yang rusak: ADX reversal < 20 (terburuk -15%) dan RSI reversal 35 (terburuk -13%).

### Tes jendela 1-15 Okt 2026

`FROM=2026-10-01 TO=2026-10-16 node strategy.js` (modal baru 100 USDT; indikator tetap pakai histori penuh).

| Item | Hasil |
|---|---|
| BTC dalam periode | 83576.8 -> 82195.4 (-1.7%) |
| Trade | 1: Pullback LONG 9 Okt 03:00, entry 82083.4, SL 81289.5, TP 83671.1 kena 11 Okt 15:45 |
| Hasil | +1.82R, 100 -> 104.34 USDT (+4.3%) |
| Fee 0.10% / telat 15m | 104.09 / 104.34 |

Hanya 1 trade karena ADX4h berada di zona 15-35 (tanpa setup) pada 83 dari 90 candle 4h.
Periode ini **bagian dari data pembentuk aturan**, jadi bukan tes out-of-sample.

### Tes jendela 1-15 Sep 2026

`FROM=2026-09-01 TO=2026-09-16 node strategy.js`: **0 trade**, 100 -> 100.00. BTC 78549.6 -> 75599.9 (-3.8%).
ADX4h: 0 candle >= 35 (A/B mati), 17 candle < 15 (C aktif, tapi tidak ada close di luar Bollinger dengan RSI <= 30 / >= 70 lalu kembali ke dalam), 73 candle di zona 15-35.
Semua trade September di run penuh terjadi 20-30 Sep.

## 9. Profil AKTIF (~13 trade/bulan)

`PROFILE=aktif node strategy.js` -> `TRADES_aktif.xlsx`.
Semua aturan profil utama (A, B, C, risiko 3%) tetap. Tambahannya: kalau A/B/C tidak ada sinyal, cek **A2**.

### Strategi A2 - Continuation risiko kecil

| | LONG | SHORT |
|---|---|---|
| Regime | UP (ADX4h berapa saja) | DOWN (ADX4h berapa saja) |
| Trigger 1h | close > Donchian 24h high candle sebelumnya | close < Donchian 24h low candle sebelumnya |
| Volume | vol_ratio 1h >= 2.0 | vol_ratio 1h >= 2.0 |
| SL awal | entry - 1.5 x ATR1h | entry + 1.5 x ATR1h |
| TP | 3R | 3R |
| Trailing | tiap close 15m, jarak 3 x ATR1h | sama |
| Waktu maks | 24 jam | 24 jam |
| Risiko | **1% equity** | **1% equity** |

Di profil ini TP dipasang sebagai **limit order** (fee maker 0.02%), untuk semua setup.

| Hasil in-sample | Utama | Aktif |
|---|---|---|
| Trade | 42 (4.4/bulan) | 123 (12.8/bulan) |
| Trade per bulan (bulan close) | - | 8, 17, 8, 15, 16, 18, 9, 13, 13, 6 (Okt s/d 18) |
| Akhir | 192.95 | 198.87 |
| Bulan profit | 7/10 | 7/10 |
| Bulan profit < 5% | 0 | 0 |
| Bulan terburuk | -6.2% | -7.0% |
| Max drawdown | 10.8% | 12.0% |
| Fee 0.10%/sisi | 169.73, 7/10 | 169.25, 7/10, terburuk -9.1%, 1 bulan profit < 5% |
| Entry telat 15m | 179.87, 7/10 | 189.93, 7/10, terburuk -5.9% |
| Entry telat 30m | 154.30, 7/10 | 131.34, 7/10, terburuk -10.4% |

Bulanan aktif: Jan +14.5, Feb +12.7, Mar -2.4, Apr +5.6, Mei -7.0, Jun +22.2, Jul -3.2, Agu +6.7, Sep +16.2, Okt +9.6.

| Setup (aktif) | Sisi | Trade | Menang | Total R |
|---|---|---|---|---|
| A Continuation | Long / Short | 8 / 9 | 3 / 5 | +1.7 / +11.1 |
| B Pullback | Long / Short | 9 / 8 | 6 / 4 | +6.8 / +2.4 |
| C Reversal | Long / Short | 1 / 4 | 1 / 2 | +1.9 / +1.1 |
| A2 Continuation | Long / Short | 39 / 45 | 16 / 15 | +11.7 / -0.6 |

Stabilitas: 19 dari 20 varian parameter A2 yang digeser satu langkah (ADX gate, volume, SL, TP, trailing, waktu maks, risiko) tetap 7/10 bulan profit, bulan terburuk -5.0% s/d -10.3%. Risiko A2 2% sudah rusak (6/10, terburuk -11.7%).

Catatan jujur:
- Profit tetap datang dari A, B, C. A2 menambah +11.1R dari 84 trade (~+0.13R/trade); dengan fee 0.10% kontribusinya hampir nol.
- A2 Short hampir impas. A2 menambah frekuensi, bukan edge besar.
- Entry telat 30 menit menurunkan hasil jauh lebih banyak dibanding profil utama: eksekusi harus disiplin di candle 15m pertama.
- Tes jendela 1-15 Sep 2026 (`PROFILE=aktif FROM=2026-09-01 TO=2026-09-16`): 6 trade, semua A2 LONG, 2 menang (+2.92R, +2.87R), 4 kalah (~-1.1R). 100 -> 100.89 (+0.9%), drawdown 3.8%. Fee 0.10%: 100.29; telat 15m: 101.31. Profil utama di jendela sama: 0 trade.
- Tes jendela 1-30 Sep 2026 (`TO=2026-10-01`): 14 trade (A 2, B 2, C 1, A2 9), 9 menang. 100 -> 115.03 (+15.0%), drawdown 3.8%. Fee 0.10%: 113.28; telat 15m: 118.49. Reversal SHORT 30 Sep ditutup paksa di akhir jendela (+0.82R).
- Versi aktif lama (tanpa gate ADX untuk A dan B, ~16 trade/bulan, akhir 150.05, drawdown 24.6%) dibuang karena lebih buruk dan tidak stabil.

## 10. Output xlsx

Setiap run menulis workbook (`TRADES.xlsx`, `TRADES_aktif.xlsx`, `TRADES_<FROM>_<TO>.xlsx`):
- **Ringkasan**: per bulan (bulan close trade) equity awal, jumlah trade, win, win rate, PnL, equity akhir, return. Semua pakai rumus `COUNTIFS`/`SUMIFS` ke sheet Trades.
- **Trades**: satu baris per trade.
- **Parameter**: parameter profil, fee, delay, jendela.

## 11. Batasan (wajib dibaca)

- **In-sample.** Parameter dipilih dari data Jan-Okt 2026 ini. Tidak ada data out-of-sample, jadi angka di atas bukan janji.
- **Sampel kecil:** 42 trade (~4 per bulan). Satu-dua trade besar mengubah hasil bulanan.
- **Aturan sama di ETH dan HYPE rugi** (ETH 82.0, HYPE 88.9; hanya 3/10 bulan profit). Edge ini kemungkinan besar khas BTC 2026, bukan pola umum.
- Continuation Long hampir impas (+0.5R). Profit terbesar datang dari Short di tahun BTC turun.
- Akun 100 USDT dekat batas qty 0.001 BTC: banyak trade pakai qty 0.001-0.002, jadi risiko riil sering < 3%.
- Hasil live akan beda karena slippage, funding riil, dan eksekusi manual.
