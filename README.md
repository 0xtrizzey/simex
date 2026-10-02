# SimEx – crypto paper-trading dashboard

A free, exchange-style **paper-trading simulator** with **live Hyperliquid market data** (no API key, no Binance),
TradingView charts, unlimited accounts with custom size and fees, and a full set of quant statistics.
Use it to practise, backtest your discipline, and track a real equity curve – without risking money.

> ⚠️ Simulation only. Not financial advice. Fills, fees and liquidations are modelled approximations of a real exchange.

## Run it – pick one

| Option | How |
|---|---|
| **Windows app (easiest)** | Download **`SimEx-windows.zip`** from [Releases](../../releases/latest), unzip, double-click **`SimEx.exe`**. Your browser opens automatically. Data is saved in a `data` folder next to the exe. *(Windows may show a SmartScreen warning because the exe is unsigned: **More info → Run anyway**.)* |
| **In the browser (no install)** | Open the hosted version: **https://0xtrizzey.github.io/simex/** – everything is stored in your own browser. |
| **From source** | Install [Node.js](https://nodejs.org), then `git clone` this repo and double-click `start.bat` (Windows) or run `node server.js` and open http://localhost:8765. Data goes to `data/state.json`. |
| **Just the files** | Serve the folder with any static server (e.g. `python -m http.server`) and open it – no Node needed, data stays in the browser. Opening `index.html` directly usually works in Chrome / Edge too. |

Stop the local app by closing its window (or `stop.bat`).

## Features

**Trading**
- Market / Limit / Stop-Market orders, reduce-only, cross & isolated margin, leverage **1–100x on every pair**
- **Partial take-profits** (up to 5 levels, each closes its own %) + stop-loss – on positions *and* on pending limit orders
- Drag TP / SL / order lines directly on the chart; click an entry or order → *Add take-profit / stop-loss* → the line follows your mouse, click to place it
- Selecting Limit/Stop shows a temporary draft line on the chart right away (drag it, then Buy / Sell)
- Right-click chart for quick limit / stop orders; drawing tools (trend line, ray, horizontal line, rectangle, fib, measure)
- Real order-book slippage for market orders, maker / taker fees per account, hourly funding with real rates
- Liquidation: Bybit-style maintenance margin (0.5% base tier + closing fee). 100x ≈ liquidated after a ~0.45% move, 10x ≈ 9.5%
- If the page was closed, TP / SL / limit fills / liquidations are replayed from candle data when you reopen it

**Accounts & analytics**
- Unlimited accounts, each with its own start size, maker/taker fees, positions, history and stats
- Win rate, profit factor, expectancy (also in R), payoff, Kelly, SQN, Sharpe, Sortino, Calmar, max drawdown, MAE / MFE, streaks, long-vs-short, per-symbol, by hour / weekday, P&L distribution
- Equity curve, drawdown curve and daily P&L chart, P&L calendar (month / year), CSV export, full JSON backup

## Data & privacy
All trading data stays on your machine (`data/state.json` or browser storage). The only network traffic is to the public
[Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api) for prices, and Google Fonts for the typeface.

## Build the Windows exe yourself
```
node build-exe.js      # → dist/SimEx.exe  (Node 20+, uses Node's single-executable feature)
```

## Notes
- Prices are Hyperliquid USDC perpetuals displayed as `…USDT` (≈ 1:1); `kPEPE` is shown as `1000PEPE`.
- Hyperliquid keeps the latest 5000 candles per timeframe, which is the history the chart can load.

## License
[MIT](LICENSE). Charts by [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache-2.0) – see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
