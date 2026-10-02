/* SimEx – live market data from Hyperliquid (REST + WebSocket). No API key needed. */
(function () {
  const REST = 'https://api.hyperliquid.xyz/info';
  const WSURL = 'wss://api.hyperliquid.xyz/ws';
  const F = (window.Feed = {
    name: 'Hyperliquid',
    markets: [],
    bySym: {},
    byCoin: {},
    mids: {},
    midTs: {},
    ctx: {},
    books: {},
    connected: false,
    focus: { coin: null, interval: null },
  });

  F.IV = {
    '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
    '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3,
    '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
  };

  F.post = async (body) => {
    const r = await fetch(REST, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  /* ---------- markets / contexts ---------- */
  function applyCtxs(ctxs) {
    F.markets.forEach((m) => {
      const c = ctxs[m.idx];
      if (!c) return;
      applyOneCtx(m, c);
    });
  }
  function applyOneCtx(m, c) {
    const mark = +c.markPx || +c.midPx || 0;
    const prev = +c.prevDayPx || 0;
    F.ctx[m.sym] = {
      mark,
      oracle: +c.oraclePx || mark,
      mid: +c.midPx || mark,
      funding: +c.funding || 0,
      oi: (+c.openInterest || 0) * mark,
      vol: +c.dayNtlVlm || 0,
      prev,
      chg: prev ? ((mark - prev) / prev) * 100 : 0,
    };
    if (!F.mids[m.coin] && mark) {
      F.mids[m.coin] = mark;
      F.midTs[m.coin] = Date.now();
    }
  }

  F.loadMeta = async () => {
    const [meta, ctxs] = await F.post({ type: 'metaAndAssetCtxs' });
    F.markets = [];
    F.bySym = {};
    F.byCoin = {};
    meta.universe.forEach((u, i) => {
      if (u.isDelisted) return;
      const base = /^k[A-Z]/.test(u.name) ? '1000' + u.name.slice(1) : u.name;
      const m = {
        coin: u.name,
        base,
        sym: base + 'USDT',
        idx: i,
        szDec: u.szDecimals,
        maxLev: 100, // simulator allows up to 100x on every market
        hlMaxLev: u.maxLeverage,
        onlyIsolated: false,
      };
      F.markets.push(m);
      F.bySym[m.sym] = m;
      F.byCoin[m.coin] = m;
    });
    applyCtxs(ctxs);
    U.emit('feed:meta');
  };

  F.refreshCtx = async () => {
    try {
      const [, ctxs] = await F.post({ type: 'metaAndAssetCtxs' });
      applyCtxs(ctxs);
      U.emit('feed:ctx');
    } catch (e) {
      /* ignore transient errors */
    }
  };
  F.startCtxPolling = () => setInterval(F.refreshCtx, 5000);

  /* ---------- candles ---------- */
  F.candles = async (coin, interval, start, end) => {
    const rows = await F.post({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(start), endTime: Math.floor(end) } });
    return rows.map(cvtCandle);
  };
  function cvtCandle(c) {
    return { time: Math.floor(c.t / 1000), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v };
  }
  // Hyperliquid only serves the latest 5000 candles per interval.
  F.history = (coin, interval, n = 5000) => {
    const now = Date.now();
    return F.candles(coin, interval, now - n * F.IV[interval], now);
  };
  F.fundingHistory = (coin, start) => F.post({ type: 'fundingHistory', coin, startTime: Math.floor(start) });

  /* ---------- prices / book helpers ---------- */
  F.mid = (sym) => {
    const m = F.bySym[sym];
    return m ? F.mids[m.coin] || (F.ctx[sym] && F.ctx[sym].mark) || 0 : 0;
  };
  F.midAge = (sym) => {
    const m = F.bySym[sym];
    return m ? Date.now() - (F.midTs[m.coin] || 0) : Infinity;
  };
  F.fresh = (sym) => F.midAge(sym) < 20000;
  F.book = (sym) => {
    const m = F.bySym[sym];
    const b = m && F.books[m.coin];
    return b && Date.now() - b.recv < 8000 ? b : null;
  };
  F.bestBidAsk = (sym) => {
    const b = F.book(sym);
    if (b && b.bids.length && b.asks.length) return { bid: b.bids[0].px, ask: b.asks[0].px };
    const mid = F.mid(sym);
    return { bid: mid * 0.9999, ask: mid * 1.0001 };
  };
  // Average fill price for a market order of `qty` base units (walks the order book).
  F.fillPrice = (sym, side, qty) => {
    const b = F.book(sym);
    const mid = F.mid(sym);
    const levels = b && (side === 'buy' ? b.asks : b.bids);
    if (!levels || !levels.length) return mid * (side === 'buy' ? 1.0002 : 0.9998);
    let rem = qty, cost = 0, last = levels[0].px;
    for (const lv of levels) {
      const take = Math.min(rem, lv.sz);
      cost += take * lv.px;
      rem -= take;
      last = lv.px;
      if (rem <= 1e-12) break;
    }
    if (rem > 1e-12) cost += rem * last * (side === 'buy' ? 1.0005 : 0.9995); // beyond visible depth
    return cost / qty;
  };

  /* ---------- websocket ---------- */
  let ws = null, pingT = null, retry = 0;
  const subs = new Map();
  const subKey = (s) => JSON.stringify(s);
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

  F.sub = (s) => {
    const k = subKey(s);
    if (subs.has(k)) return;
    subs.set(k, s);
    send({ method: 'subscribe', subscription: s });
  };
  F.unsub = (s) => {
    const k = subKey(s);
    if (!subs.has(k)) return;
    subs.delete(k);
    send({ method: 'unsubscribe', subscription: s });
  };

  F.connect = () => {
    try {
      ws = new WebSocket(WSURL);
    } catch (e) {
      return setTimeout(F.connect, 3000);
    }
    ws.onopen = () => {
      retry = 0;
      F.connected = true;
      U.emit('feed:status', true);
      subs.forEach((s) => send({ method: 'subscribe', subscription: s }));
      clearInterval(pingT);
      pingT = setInterval(() => send({ method: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      F.lastMsg = Date.now();
      handle(msg);
    };
    ws.onclose = () => {
      F.connected = false;
      clearInterval(pingT);
      U.emit('feed:status', false);
      setTimeout(F.connect, Math.min(10000, 1000 + retry++ * 1500));
    };
    ws.onerror = () => {
      try { ws.close(); } catch (e) { /* noop */ }
    };
  };

  function handle(msg) {
    const { channel, data } = msg;
    if (channel === 'allMids') {
      const now = Date.now();
      const changed = [];
      const mids = data.mids || {};
      for (const coin in mids) {
        const m = F.byCoin[coin];
        if (!m) continue;
        const px = +mids[coin];
        if (px && px !== F.mids[coin]) {
          F.mids[coin] = px;
          changed.push(m.sym);
        }
        F.midTs[coin] = now;
      }
      U.emit('feed:mids', changed);
    } else if (channel === 'candle') {
      const arr = Array.isArray(data) ? data : [data];
      arr.forEach((c) => U.emit('feed:candle', { coin: c.s, interval: c.i, ...cvtCandle(c) }));
    } else if (channel === 'l2Book') {
      const [bids, asks] = data.levels;
      F.books[data.coin] = {
        recv: Date.now(),
        time: data.time,
        bids: bids.map((l) => ({ px: +l.px, sz: +l.sz })),
        asks: asks.map((l) => ({ px: +l.px, sz: +l.sz })),
      };
      U.emit('feed:book', data.coin);
    } else if (channel === 'trades') {
      const rows = data.map((t) => ({ coin: t.coin, px: +t.px, sz: +t.sz, side: t.side === 'B' ? 'buy' : 'sell', time: t.time, id: t.tid }));
      if (rows.length) U.emit('feed:trades', rows[0].coin, rows);
    } else if (channel === 'activeAssetCtx') {
      const m = F.byCoin[data.coin];
      if (m && data.ctx) {
        applyOneCtx(m, data.ctx);
        U.emit('feed:ctx');
      }
    }
  }

  // Which coin the chart / order book is looking at
  F.setFocus = (coin, interval) => {
    const f = F.focus;
    if (f.coin !== coin) {
      if (f.coin) {
        F.unsub({ type: 'l2Book', coin: f.coin });
        F.unsub({ type: 'trades', coin: f.coin });
        F.unsub({ type: 'activeAssetCtx', coin: f.coin });
      }
      F.sub({ type: 'l2Book', coin });
      F.sub({ type: 'trades', coin });
      F.sub({ type: 'activeAssetCtx', coin });
    }
    if (f.coin !== coin || f.interval !== interval) {
      if (f.coin) F.unsub({ type: 'candle', coin: f.coin, interval: f.interval });
      F.sub({ type: 'candle', coin, interval });
    }
    f.coin = coin;
    f.interval = interval;
  };

  F.start = () => {
    F.sub({ type: 'allMids' });
    F.connect();
    F.startCtxPolling();
  };
})();
