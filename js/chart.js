/* SimEx – TradingView Lightweight Charts integration
 * candles + live updates, indicators, draggable position / order lines, drawing tools.
 */
(function () {
  const LW = window.LightweightCharts;
  const CV = (window.ChartView = {});
  const GREEN = '#2ebd85', RED = '#f6465d', ACCENT = '#f7a600', LIQ = '#ff7849', STOP = '#b78bff';

  let chart, candleS, volS, wrap, tagsEl, cvs, ctx, legendEl;
  let candles = [];
  let market = null, interval = '1m', ivSec = 60, token = 0, dec = 2;
  let visible = true;
  const indSeries = {}; // key -> [series]
  const indVals = {}; // key -> [arrays aligned with candles]

  /* =========================================================== helpers */
  const fmtP = (p) => U.fmt(p, dec);
  const bars = () => candles.length;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function timeFmt(t) {
    const d = new Date(t * 1000);
    const base = `${d.getFullYear()}-${U.p2(d.getMonth() + 1)}-${U.p2(d.getDate())}`;
    return ivSec >= 86400 ? base : `${dayNames[d.getDay()]} ${base} ${U.p2(d.getHours())}:${U.p2(d.getMinutes())}`;
  }
  function tickFmt(t, type) {
    const d = new Date(t * 1000);
    switch (type) {
      case 0: return String(d.getFullYear());
      case 1: return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      case 2: return String(d.getDate());
      default: return U.p2(d.getHours()) + ':' + U.p2(d.getMinutes());
    }
  }
  function plotSize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    let axisW = 0, timeH = 0, paneH = h;
    try { axisW = chart.priceScale('right').width(); } catch (e) { /* noop */ }
    try { timeH = chart.timeScale().height(); } catch (e) { /* noop */ }
    try { paneH = chart.panes()[0].getHeight(); } catch (e) { paneH = h - timeH; }
    return { w, h, plotW: w - axisW, paneH };
  }

  /* index <-> time mapping (supports positions beyond the data range) */
  function timeToIdx(t) {
    const n = candles.length;
    if (!n) return 0;
    if (t <= candles[0].time) return (t - candles[0].time) / ivSec;
    if (t >= candles[n - 1].time) return n - 1 + (t - candles[n - 1].time) / ivSec;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) lo = mid; else hi = mid;
    }
    return lo + (t - candles[lo].time) / (candles[hi].time - candles[lo].time);
  }
  function idxToTime(i) {
    const n = candles.length;
    if (!n) return 0;
    if (i <= 0) return candles[0].time + i * ivSec;
    if (i >= n - 1) return candles[n - 1].time + (i - (n - 1)) * ivSec;
    const lo = Math.floor(i);
    return candles[lo].time + (i - lo) * (candles[lo + 1].time - candles[lo].time);
  }
  const timeToX = (t) => chart.timeScale().logicalToCoordinate(timeToIdx(t));
  const xToTime = (x) => {
    const l = chart.timeScale().coordinateToLogical(x);
    return l == null ? null : idxToTime(l);
  };
  const priceToY = (p) => candleS.priceToCoordinate(p);
  const yToPrice = (y) => candleS.coordinateToPrice(y);
  const snapPx = (p) => {
    const tick = Math.pow(10, -dec);
    return Math.round(p / tick) * tick;
  };

  /* =========================================================== indicators */
  const calcSMA = (v, n) => {
    const o = new Array(v.length).fill(null);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= n) s -= v[i - n];
      if (i >= n - 1) o[i] = s / n;
    }
    return o;
  };
  const calcEMA = (v, n) => {
    const o = new Array(v.length).fill(null);
    const k = 2 / (n + 1);
    let e = null, s = 0;
    for (let i = 0; i < v.length; i++) {
      if (i < n) {
        s += v[i];
        if (i === n - 1) { e = s / n; o[i] = e; }
      } else {
        e = v[i] * k + e * (1 - k);
        o[i] = e;
      }
    }
    return o;
  };
  const calcBOLL = (v, n, k) => {
    const mid = calcSMA(v, n), up = new Array(v.length).fill(null), lo = new Array(v.length).fill(null);
    for (let i = n - 1; i < v.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) * (v[j] - mid[i]);
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd;
      lo[i] = mid[i] - k * sd;
    }
    return [up, mid, lo];
  };
  const calcRSI = (v, n) => {
    const o = new Array(v.length).fill(null);
    if (v.length <= n) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) {
      const d = v[i] - v[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= n; l /= n;
    o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
      l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
      o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return o;
  };

  const INDS = {
    ma: { label: 'MA', sub: '7 · 30 · 99', colors: ['#b57bff', '#f0c14b', '#3b8cf0'], names: ['MA 7', 'MA 30', 'MA 99'], calc: (c) => [7, 30, 99].map((n) => calcSMA(c, n)) },
    ema: { label: 'EMA', sub: '20 · 50 · 200', colors: ['#ff9f43', '#4cc9f0', '#e056a0'], names: ['EMA 20', 'EMA 50', 'EMA 200'], calc: (c) => [20, 50, 200].map((n) => calcEMA(c, n)) },
    boll: { label: 'BOLL', sub: '20 · 2', colors: ['#5b7fb8', '#d9a441', '#5b7fb8'], names: ['UP', 'MB', 'DN'], calc: (c) => calcBOLL(c, 20, 2) },
    rsi: { label: 'RSI', sub: '14', colors: ['#b57bff'], names: ['RSI 14'], pane: 1, calc: (c) => [calcRSI(c, 14)] },
  };
  const defaultInds = { ma: true, ema: false, boll: false, rsi: false, vol: true };
  const getInds = () => Object.assign({}, defaultInds, Engine.prefs().inds || {});

  const toData = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i++) if (arr[i] != null) out.push({ time: candles[i].time, value: arr[i] });
    return out;
  };
  function enableInd(k) {
    if (indSeries[k]) return;
    const d = INDS[k];
    indSeries[k] = d.colors.map((c) =>
      chart.addSeries(
        LW.LineSeries,
        { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: k === 'rsi' ? { type: 'price', precision: 1, minMove: 0.1 } : { type: 'price', precision: dec, minMove: Math.pow(10, -dec) } },
        d.pane || 0
      )
    );
    if (k === 'rsi') {
      indSeries[k][0].createPriceLine({ price: 70, color: '#3a4350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      indSeries[k][0].createPriceLine({ price: 30, color: '#3a4350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      try { chart.panes()[1].setHeight(120); } catch (e) { /* noop */ }
    }
    recalcInd(k);
  }
  function disableInd(k) {
    if (!indSeries[k]) return;
    indSeries[k].forEach((s) => chart.removeSeries(s));
    delete indSeries[k];
    delete indVals[k];
  }
  function recalcInd(k) {
    if (!indSeries[k]) return;
    const closes = candles.map((c) => c.close);
    const arrs = INDS[k].calc(closes);
    indVals[k] = arrs;
    arrs.forEach((a, i) => indSeries[k][i].setData(toData(a)));
  }
  function updateIndLast() {
    if (!candles.length) return;
    const closes = candles.map((c) => c.close);
    const i = candles.length - 1;
    for (const k in indSeries) {
      const arrs = INDS[k].calc(closes);
      indVals[k] = arrs;
      arrs.forEach((a, j) => a[i] != null && indSeries[k][j].update({ time: candles[i].time, value: a[i] }));
    }
  }
  function applyIndPrefs() {
    const p = getInds();
    Object.keys(INDS).forEach((k) => (p[k] ? enableInd(k) : disableInd(k)));
    volS.applyOptions({ visible: !!p.vol });
    renderLegend();
  }
  CV.toggleInd = (k) => {
    const p = getInds();
    p[k] = !p[k];
    Engine.setPref('inds', p);
    applyIndPrefs();
  };

  /* =========================================================== legend */
  let hoverIdx = null;
  function renderLegend() {
    if (!legendEl || !market) return;
    const i = hoverIdx != null && hoverIdx < candles.length ? hoverIdx : candles.length - 1;
    const c = candles[i];
    if (!c) return (legendEl.innerHTML = '');
    const prev = candles[i - 1];
    const chg = prev ? c.close - prev.close : c.close - c.open;
    const chgPct = prev ? (chg / prev.close) * 100 : 0;
    const col = c.close >= c.open ? GREEN : RED;
    const ivLabel = interval.replace(/m$/, '').replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');
    let html = `<div class="lg-row"><span class="lg-sym">${market.sym}</span><span class="lg-dim">· ${ivLabel} · Perp · ${Feed.name}</span>
      <span class="lg-v" style="color:${col}"><i>O</i>${fmtP(c.open)} <i>H</i>${fmtP(c.high)} <i>L</i>${fmtP(c.low)} <i>C</i>${fmtP(c.close)} ${U.fmtS(chg, dec)} (${U.fmtPct(chgPct)})</span></div>`;
    const p = getInds();
    for (const k in indSeries) {
      if (!p[k] || !indVals[k]) continue;
      html += `<div class="lg-row lg-ind">` + INDS[k].names.map((nm, j) => {
        const v = indVals[k][j] && indVals[k][j][i];
        return `<span class="lg-dim">${nm}</span> <b style="color:${INDS[k].colors[j]}">${v == null ? '–' : k === 'rsi' ? v.toFixed(2) : fmtP(v)}</b>`;
      }).join(' ') + `</div>`;
    }
    if (p.vol) html += `<div class="lg-row lg-ind"><span class="lg-dim">Vol</span> <b style="color:${col}">${U.fmtCompact(c.volume)}</b> <span class="lg-dim">${market.base}</span></div>`;
    legendEl.innerHTML = html;
  }

  /* =========================================================== data */
  const volColor = (c) => (c.close >= c.open ? 'rgba(46,189,133,0.32)' : 'rgba(246,70,93,0.32)');
  const volPoint = (c) => ({ time: c.time, value: c.volume, color: volColor(c) });

  CV.load = async (sym, iv) => {
    const m = Feed.bySym[sym];
    if (!m) return;
    const tok = ++token;
    market = m;
    interval = iv;
    ivSec = Feed.IV[iv] / 1000;
    dec = U.pxDec(Feed.mid(sym) || 1, m.szDec);
    U.$('#chart-loading').classList.add('show');
    Feed.setFocus(m.coin, iv);
    let data;
    try {
      data = await Feed.history(m.coin, iv, 5000);
    } catch (e) {
      if (tok === token) {
        U.$('#chart-loading').innerHTML = '<span>Failed to load candles – retrying…</span>';
        setTimeout(() => tok === token && CV.load(sym, iv), 2500);
      }
      return;
    }
    if (tok !== token) return;
    U.$('#chart-loading').classList.remove('show');
    candles = data;
    const last = candles.length ? candles[candles.length - 1].close : 1;
    dec = U.pxDec(last, m.szDec);
    candleS.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: Math.pow(10, -dec) } });
    candleS.setData(candles);
    volS.setData(candles.map(volPoint));
    Object.keys(indSeries).forEach((k) => {
      indSeries[k].forEach((s) => s.applyOptions({ priceFormat: k === 'rsi' ? { type: 'price', precision: 1, minMove: 0.1 } : { type: 'price', precision: dec, minMove: Math.pow(10, -dec) } }));
      recalcInd(k);
    });
    const n = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - 150), to: n + 12 });
    chart.priceScale('right').applyOptions({ autoScale: true });
    hoverIdx = null;
    loadDrawings();
    renderLegend();
    CV.syncTrade();
    dirty = true;
    U.emit('chart:loaded', { sym, interval });
  };

  U.on('feed:candle', (c) => {
    if (!market || c.coin !== market.coin || c.interval !== interval || !candles.length) return;
    const last = candles[candles.length - 1];
    if (c.time < last.time) return;
    const bar = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    if (c.time === last.time) candles[candles.length - 1] = bar;
    else candles.push(bar);
    candleS.update(bar);
    volS.update(volPoint(bar));
    updateIndLast();
    if (hoverIdx == null) renderLegend();
  });

  CV.lastCandle = () => candles[candles.length - 1];
  CV.interval = () => interval;
  CV.market = () => market;

  /* =========================================================== trade lines */
  const lines = new Map(); // key -> line
  let drag = null;
  let placing = null; // { kind, color, label, est, commit(price) } – a new TP/SL line that follows the cursor until you click
  let ph = null; // preview of the placing line { pl, el, price }

  const tpWord = (kind) => (kind === 'tp' ? 'take-profit' : 'stop-loss');

  function estText(l, price) {
    const e = l.est;
    if (!e || !(e.size > 0)) return { t: fmtP(price), c: '' };
    const qty = e.size * (l.kind === 'tp' ? (l.pct || 100) / 100 : 1);
    const dir = e.dir || (l.kind === 'tp' ? (price > e.entry ? 1 : -1) : price < e.entry ? 1 : -1);
    const pnl = dir * qty * (price - e.entry);
    const margin = (e.size * e.entry) / (e.lev || 1);
    return { t: `${fmtP(price)} · ${U.fmtS(pnl)} USDT (${U.fmtPct(margin ? (pnl / margin) * 100 : 0, 1)})`, c: U.cls(pnl) };
  }

  function liveText(l) {
    if (l.kind === 'entry') {
      const a = Engine.active();
      const pos = a && market && a.positions[market.sym];
      if (!pos) return { t: '', c: '' };
      const q = Engine.metrics(a).per[market.sym];
      return { t: `${U.fmtS(q.u)} USDT (${U.fmtPct(q.roe)})`, c: U.cls(q.u) };
    }
    if (l.kind === 'tp' || l.kind === 'sl') return estText(l, l.price);
    if (l.kind === 'order' || l.kind === 'draft') return { t: `@ ${fmtP(l.price)}`, c: '' };
    if (l.kind === 'liq') return { t: fmtP(l.price), c: '' };
    return { t: '', c: '' };
  }

  const MENU_BTN = '<button class="tg-btn" data-act="menu" title="Add take-profit / stop-loss">TP/SL ▾</button>';
  function tagHtml(l) {
    switch (l.kind) {
      case 'entry':
        return `<b class="tg-side ${l.side}">${l.side === 'long' ? 'LONG' : 'SHORT'}</b><span class="tg-txt">${l.qtyText}</span><span class="tg-live"></span>${MENU_BTN}<button class="tg-btn" data-act="close">Close</button>`;
      case 'tp':
        return `<b class="tg-lab tp">${l.draft ? 'TP' : 'TP'}${l.n}</b><button class="tg-pct" data-act="pct" title="Share of the position closed at this take-profit">${+(+l.pct).toFixed(2)}%</button><span class="tg-live"></span><button class="tg-x" data-act="remove" title="Remove">✕</button>`;
      case 'sl':
        return `<b class="tg-lab sl">SL</b><span class="tg-live"></span><button class="tg-x" data-act="remove" title="Remove">✕</button>`;
      case 'liq':
        return `<b class="tg-lab liq">LIQ</b><span class="tg-live"></span>`;
      case 'order':
        return `<b class="tg-lab ${l.order.side === 'buy' ? 'buy' : 'sell'}">${l.order.type === 'stop' ? 'Stop' : 'Limit'} ${l.order.side === 'buy' ? 'Buy' : 'Sell'}</b><span class="tg-txt">${l.qtyText}${l.order.reduceOnly ? ' · RO' : ''}</span><span class="tg-live"></span>${l.order.reduceOnly ? '' : MENU_BTN}<button class="tg-x" data-act="remove" title="Cancel order">✕</button>`;
      case 'draft':
        return `<b class="tg-lab draft">${l.label}</b><span class="tg-live"></span><button class="tg-btn buy" data-act="buy">Buy</button><button class="tg-btn sell" data-act="sell">Sell</button>${MENU_BTN}<button class="tg-x" data-act="remove" title="Discard draft">✕</button>`;
    }
    return '';
  }

  // Menu to choose what to add (TP or SL); the chosen line then follows the mouse until you click to place it.
  function tpslMenu(ev, spec) {
    const x = ev.clientX, y = ev.clientY;
    const items = [{ head: spec.title }];
    items.push({ label: `<span class="up">＋</span> Add take-profit${spec.tpCount ? ` (${spec.tpCount}/5)` : ''}`, disabled: spec.tpCount >= 5, onClick: () => CV.startPlacing({ kind: 'tp', est: spec.est, commit: (p) => spec.add('tp', p) }) });
    items.push({ label: `<span class="down">＋</span> Add stop-loss`, disabled: spec.hasSl, onClick: () => CV.startPlacing({ kind: 'sl', est: spec.est, commit: (p) => spec.add('sl', p) }) });
    if (spec.extra && spec.extra.length) {
      items.push({ sep: true });
      spec.extra.forEach((x2) => items.push(x2));
    }
    U.menu(x, y, items);
  }

  CV.syncTrade = () => {
    if (!chart || !market) return;
    const a = Engine.active();
    const sym = market.sym;
    const descs = [];
    const toast = (r) => r && !r.ok && U.toast(r.error, 'err');
    if (a) {
      const pos = a.positions[sym];
      if (pos) {
        const q = Engine.metrics(a).per[sym];
        const ref = { kind: 'pos', sym };
        const dir = pos.side === 'long' ? 1 : -1;
        descs.push({
          key: 'entry', kind: 'entry', price: pos.entry, color: ACCENT, style: 0, side: pos.side,
          qtyText: `${U.fmtQty(pos.size, market.szDec)} ${market.base} · ${pos.lev}x`, autoscale: true,
          click: (ev) =>
            tpslMenu(ev, {
              title: `${pos.side === 'long' ? 'Long' : 'Short'} ${market.sym}`, tpCount: pos.tps.length, hasSl: !!pos.sl,
              est: { entry: pos.entry, size: pos.size, dir, lev: pos.lev },
              add: (k, p) => (k === 'tp' ? Engine.tpAdd(a.id, ref, p) : Engine.slSet(a.id, ref, p)),
              extra: [
                { label: 'Edit TP / SL…', onClick: () => TradeUI.tpslDialog(ref) },
                { sep: true },
                ...[25, 50].map((pc) => ({ label: `Close ${pc}% at market`, onClick: () => toast(Engine.closePosition(a.id, sym, { pct: pc })) })),
                { label: 'Close position', cls: 'danger', onClick: () => toast(Engine.closePosition(a.id, sym)) },
              ],
            }),
        });
        if (q.liq) descs.push({ key: 'liq', kind: 'liq', price: q.liq, color: LIQ, style: 1 });
        pos.tps.slice().sort((x, y) => dir * (x.price - y.price)).forEach((t, i) =>
          descs.push({
            key: 'tp:' + t.id, kind: 'tp', n: i + 1, pct: t.pct, price: t.price, color: GREEN, style: 2, drag: true, autoscale: true,
            est: { entry: pos.entry, size: pos.maxSize, dir, lev: pos.lev },
            onDrop: (p) => Engine.tpUpdate(a.id, ref, t.id, { price: p }),
            onPct: (v) => Engine.tpUpdate(a.id, ref, t.id, { pct: v }),
            onRemove: () => toast(Engine.tpRemove(a.id, ref, t.id)),
          })
        );
        if (pos.sl)
          descs.push({
            key: 'sl', kind: 'sl', price: pos.sl, color: RED, style: 2, drag: true, autoscale: true,
            est: { entry: pos.entry, size: pos.size, dir, lev: pos.lev },
            onDrop: (p) => Engine.slSet(a.id, ref, p),
            onRemove: () => toast(Engine.slSet(a.id, ref, null)),
          });
      }
      a.orders.filter((o) => o.sym === sym).forEach((o) => {
        const ref = { kind: 'order', id: o.id };
        const dir = o.side === 'buy' ? 1 : -1;
        const est = { entry: o.price, size: o.size, dir, lev: o.lev };
        descs.push({
          key: 'o' + o.id, kind: 'order', order: o, price: o.price, style: 2, autoscale: true,
          color: o.type === 'stop' ? STOP : o.side === 'buy' ? GREEN : RED,
          qtyText: `${U.fmtQty(o.size, market.szDec)} ${market.base}`,
          drag: true,
          onDrop: (p) => Engine.modifyOrder(a.id, o.id, p),
          onRemove: () => Engine.cancelOrder(a.id, o.id),
          click: o.reduceOnly ? null : (ev) =>
            tpslMenu(ev, {
              title: `${o.type === 'stop' ? 'Stop' : 'Limit'} ${o.side} @ ${fmtP(o.price)}`, tpCount: o.tps.length, hasSl: !!o.sl, est,
              add: (k, p) => (k === 'tp' ? Engine.tpAdd(a.id, ref, p) : Engine.slSet(a.id, ref, p)),
              extra: [
                { label: 'Edit TP / SL…', onClick: () => TradeUI.tpslDialog(ref) },
                { sep: true },
                { label: 'Cancel order', cls: 'danger', onClick: () => Engine.cancelOrder(a.id, o.id) },
              ],
            }),
        });
        // TP / SL attached to a pending order are shown right away (dotted) and can be dragged
        o.tps.slice().sort((x, y) => dir * (x.price - y.price)).forEach((t, i) =>
          descs.push({
            key: `otp:${o.id}:${t.id}`, kind: 'tp', n: i + 1, pct: t.pct, price: t.price, color: GREEN, style: 1, drag: true, autoscale: true, est,
            onDrop: (p) => Engine.tpUpdate(a.id, ref, t.id, { price: p }),
            onPct: (v) => Engine.tpUpdate(a.id, ref, t.id, { pct: v }),
            onRemove: () => toast(Engine.tpRemove(a.id, ref, t.id)),
          })
        );
        if (o.sl)
          descs.push({
            key: 'osl:' + o.id, kind: 'sl', price: o.sl, color: RED, style: 1, drag: true, autoscale: true, est,
            onDrop: (p) => Engine.slSet(a.id, ref, p),
            onRemove: () => toast(Engine.slSet(a.id, ref, null)),
          });
      });

      // ---- temporary "draft" lines from the order form (not an order yet) ----
      const d = window.TradeUI && TradeUI.draft ? TradeUI.draft() : null;
      if (d) {
        const est = { entry: d.ref, size: d.qty, dir: 0, lev: d.lev };
        const draftSpec = {
          title: 'Draft order', tpCount: d.tps.length, hasSl: d.sl > 0, est,
          add: (k, p) => TradeUI.draftAdd(k, p),
          extra: [{ label: 'Discard draft', cls: 'danger', onClick: () => TradeUI.draftCancel() }],
        };
        if (d.price > 0)
          descs.push({
            key: 'd:price', kind: 'draft', price: d.price, color: '#c9d1dc', style: 3, drag: true, autoscale: true,
            label: d.tab === 'stop' ? 'Stop (draft)' : 'Limit (draft)',
            onDrop: (p) => TradeUI.setDraft('price', 0, p),
            onRemove: () => TradeUI.draftCancel(),
            onSide: (s) => TradeUI.submit(s),
            click: null,
            menu: (ev) => tpslMenu(ev, draftSpec),
          });
        d.tps.forEach((t) =>
          descs.push({
            key: 'd:tp:' + t.i, kind: 'tp', draft: true, n: t.i + 1, pct: t.pct, price: t.price, color: GREEN, style: 1, drag: true, autoscale: true,
            est,
            onDrop: (p) => TradeUI.setDraft('tp', t.i, p),
            onPct: (v) => TradeUI.setDraft('pct', t.i, v),
            onRemove: () => TradeUI.draftRemove('tp', t.i),
          })
        );
        if (d.sl > 0)
          descs.push({
            key: 'd:sl', kind: 'sl', draft: true, price: d.sl, color: RED, style: 1, drag: true, autoscale: true, est,
            onDrop: (p) => TradeUI.setDraft('sl', 0, p),
            onRemove: () => TradeUI.draftRemove('sl', 0),
          });
      }
    }
    const keep = new Set();
    descs.forEach((d) => {
      keep.add(d.key);
      let l = lines.get(d.key);
      const html = tagHtml(d);
      if (!l) {
        l = Object.assign({}, d);
        l.pl = candleS.createPriceLine({ price: d.price, color: d.color, lineWidth: 1, lineStyle: d.style, axisLabelVisible: true, title: '' });
        l.el = U.el(`<div class="tag k-${d.kind}${d.drag ? ' drag' : ''}${d.draft ? ' draft' : ''}" style="--c:${d.color}">${html}</div>`);
        l.el.dataset.key = d.key;
        l.live = l.el.querySelector('.tg-live');
        l.html = html;
        tagsEl.append(l.el);
        lines.set(d.key, l);
      } else {
        const isDragging = drag && drag.l === l;
        const keepPrice = l.price;
        Object.assign(l, d);
        if (isDragging) l.price = keepPrice;
        if (l.html !== html) {
          l.el.innerHTML = html;
          l.live = l.el.querySelector('.tg-live');
          l.html = html;
          l._lt = null;
          l._lc = null;
        }
        l.pl.applyOptions({ price: l.price, color: d.color, lineStyle: d.style });
      }
    });
    for (const [k, l] of lines) {
      if (!keep.has(k)) {
        candleS.removePriceLine(l.pl);
        l.el.remove();
        lines.delete(k);
      }
    }
    layoutTags(true);
    candleS.applyOptions({}); // re-run autoscale
  };

  function layoutTags() {
    if (!chart) return;
    const { paneH } = plotSize();
    const arr = [];
    const all = Array.from(lines.values());
    if (ph) all.push(ph);
    for (const l of all) {
      const y = priceToY(l.price);
      if (y == null || y < 4 || y > paneH - 4) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = '';
      l.y = y;
      arr.push(l);
    }
    arr.sort((p, q) => p.y - q.y);
    const placed = [];
    arr.forEach((l) => {
      let x = 10;
      placed.forEach((p) => {
        if (Math.abs(p.y - l.y) < 22) x = Math.max(x, p.x + p.w + 6);
      });
      l.x = x;
      l.w = l.el.offsetWidth;
      l.el.style.transform = `translate(${x}px, ${l.y - 11}px)`;
      placed.push(l);
    });
    for (const l of all) {
      if (!l.live) continue;
      const lt = liveText(l);
      if (l._lt !== lt.t) {
        l.live.textContent = lt.t;
        l._lt = lt.t;
      }
      if (l._lc !== lt.c) {
        l.live.className = 'tg-live ' + lt.c;
        l._lc = lt.c;
      }
    }
  }

  function lineAt(x, y) {
    const { plotW, paneH } = plotSize();
    if (x > plotW - 2 || x < 0 || y < 0 || y > paneH) return null;
    let best = null, bd = 6;
    for (const l of lines.values()) {
      if (!l.drag && !l.click) continue;
      const ly = priceToY(l.price);
      if (ly == null) continue;
      const d = Math.abs(ly - y);
      if (d <= bd) { bd = d; best = l; }
    }
    return best;
  }

  function startLineDrag(l, e) {
    drag = { l, orig: l.price, moved: false, x0: e.clientX, y0: e.clientY };
    if (l.drag) wrap.classList.add('dragging');
    window.addEventListener('mousemove', onLineMove);
    window.addEventListener('mouseup', onLineUp);
  }
  function onLineMove(e) {
    if (!drag || !drag.l.drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    const r = wrap.getBoundingClientRect();
    const p = yToPrice(e.clientY - r.top);
    if (p == null) return;
    drag.moved = true;
    const l = drag.l;
    l.price = snapPx(p);
    l.pl.applyOptions({ price: l.price });
    layoutTags();
  }
  function onLineUp(e) {
    window.removeEventListener('mousemove', onLineMove);
    window.removeEventListener('mouseup', onLineUp);
    wrap.classList.remove('dragging');
    if (!drag) return;
    const { l, orig, moved } = drag;
    drag = null;
    if (!moved) {
      if (l.click) l.click(e);
      return;
    }
    if (l.price === orig) return;
    const r = l.onDrop && l.onDrop(l.price);
    if (r && !r.ok) {
      U.toast(r.error, 'err');
      l.price = orig;
      l.pl.applyOptions({ price: orig });
      layoutTags();
    }
  }

  /* ---------- placing mode: the new TP / SL line follows the mouse, click to drop it ---------- */
  CV.startPlacing = ({ kind, est, commit }) => {
    cancelPlacing();
    const color = kind === 'tp' ? GREEN : RED;
    const start = candles.length ? candles[candles.length - 1].close : 0;
    placing = { kind, est, commit, price: start };
    const el = U.el(`<div class="tag k-${kind} placing" style="--c:${color}"><b class="tg-lab ${kind}">${kind === 'tp' ? 'TP' : 'SL'}</b><span class="tg-live"></span><span class="tg-txt">click to place · Esc to cancel</span></div>`);
    tagsEl.append(el);
    ph = { kind, est, price: start, el, live: el.querySelector('.tg-live'), pct: 100, pl: candleS.createPriceLine({ price: start, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' }) };
    wrap.classList.add('placing');
    layoutTags();
    U.toast(`Move the mouse to the price you want and click to place the ${tpWord(kind)} line`, 'info', 3500);
  };
  function cancelPlacing() {
    if (!placing) return;
    candleS.removePriceLine(ph.pl);
    ph.el.remove();
    placing = null;
    ph = null;
    wrap.classList.remove('placing');
  }
  function placeMove(y) {
    const p = yToPrice(y);
    if (p == null || !ph) return;
    ph.price = placing.price = snapPx(p);
    ph.pl.applyOptions({ price: ph.price });
    layoutTags();
  }
  function placeCommit() {
    const { commit, price } = placing;
    cancelPlacing();
    const r = commit(price);
    if (r && !r.ok) U.toast(r.error, 'err', 5000);
  }

  function pctPopover(btn, l) {
    const cur = +l.pct;
    const html = `<div class="pct-pop"><div class="pp-t">Close at this take-profit</div><div class="ld-quick">${[10, 25, 33, 50, 75, 100].map((v) => `<button data-p="${v}" class="${v === cur ? 'active' : ''}">${v}%</button>`).join('')}</div>
      <div class="pp-in"><input type="number" min="1" max="100" step="any" value="${cur}"><button class="btn sm primary">OK</button></div></div>`;
    const p = TradeUI.popover(btn, html);
    const apply = (v) => {
      v = +v;
      if (!(v > 0 && v <= 100)) return U.toast('Enter a size between 1 and 100 %', 'err');
      const r = l.onPct && l.onPct(v);
      if (r && !r.ok) return U.toast(r.error, 'err', 5000);
      TradeUI.closePopover();
    };
    p.querySelector('.ld-quick').onclick = (e) => {
      const b = e.target.closest('button');
      if (b) apply(b.dataset.p);
    };
    p.querySelector('.pp-in button').onclick = () => apply(p.querySelector('input').value);
    p.querySelector('input').onkeydown = (e) => e.key === 'Enter' && apply(e.target.value);
  }
  CV._pctPopover = pctPopover;
  CV._cancelPlacing = cancelPlacing;
  CV._placing = () => placing;
  CV._placeMove = placeMove;
  CV._placeCommit = placeCommit;
  CV._startLineDrag = startLineDrag;
  CV._lineAt = lineAt;
  CV._lines = lines;

  /* =========================================================== drawings */
  const TOOLS = [
    { id: 'cursor', tip: 'Cursor', svg: '<path d="M5 3l12 7-5 1.5L9.5 17z" fill="currentColor" stroke="none"/>' },
    { id: 'trend', tip: 'Trend line', svg: '<path d="M4 17L17 4"/><circle cx="4" cy="17" r="1.8" fill="currentColor"/><circle cx="17" cy="4" r="1.8" fill="currentColor"/>' },
    { id: 'ray', tip: 'Ray', svg: '<path d="M4 15L19 5"/><circle cx="4" cy="15" r="1.8" fill="currentColor"/><path d="M16 4l3 1-1 3" />' },
    { id: 'hline', tip: 'Horizontal line', svg: '<path d="M2 10h18"/><circle cx="11" cy="10" r="1.8" fill="currentColor"/>' },
    { id: 'rect', tip: 'Rectangle', svg: '<rect x="4" y="6" width="14" height="10" rx="1"/>' },
    { id: 'fib', tip: 'Fib retracement', svg: '<path d="M3 4h16M3 9h16M3 13h16M3 18h16" stroke-dasharray="3 2"/><path d="M5 18L17 4" stroke-width="1"/>' },
    { id: 'measure', tip: 'Measure', svg: '<path d="M3 15l12-12 4 4L7 19z"/><path d="M7 11l2 2M10 8l2 2M13 5l2 2"/>' },
  ];
  let tool = 'cursor';
  let drawings = [];
  let pending = null; // drawing in progress
  let measure = null;
  let selected = null;
  let dirty = true;
  let dragD = null;
  let hideDrawings = false;
  const DRAW_COLORS = { trend: '#4aa3ff', ray: '#4aa3ff', hline: '#f7a600', rect: '#a66bff', fib: '#f0c14b' };
  const FIB = [
    [0, '#8a94a3'], [0.236, '#f6465d'], [0.382, '#f7a600'], [0.5, '#2ebd85'], [0.618, '#14c4c4'], [0.786, '#3b8cf0'], [1, '#8a94a3'], [1.618, '#a66bff'],
  ];

  function loadDrawings() {
    const all = Engine.prefs().drawings || {};
    drawings = market && all[market.sym] ? all[market.sym] : [];
    selected = null;
    pending = null;
    measure = null;
    dirty = true;
  }
  const saveDrawings = U.debounce(() => {
    if (!market) return;
    const all = Engine.prefs().drawings || {};
    all[market.sym] = drawings;
    Engine.setPref('drawings', all);
  }, 300);

  function setTool(t) {
    tool = t;
    pending = null;
    if (t !== 'measure') measure = null;
    cvs.style.pointerEvents = t === 'cursor' ? 'none' : 'auto';
    cvs.style.cursor = t === 'cursor' ? '' : 'crosshair';
    U.$$('#draw-toolbar .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    dirty = true;
  }

  function buildDrawToolbar() {
    const host = U.$('#draw-toolbar');
    host.innerHTML =
      TOOLS.map((t) => `<button class="tool ${t.id === 'cursor' ? 'active' : ''}" data-tool="${t.id}" title="${t.tip}"><svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${t.svg}</svg></button>`).join('') +
      `<div class="tool-sep"></div>
       <button class="tool" data-act="eye" title="Show / hide drawings"><svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="11" cy="11" r="2.5"/></svg></button>
       <button class="tool" data-act="trash" title="Remove all drawings for this pair"><svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h14M9 6V4h4v2M6 6l1 12h8l1-12M9 9v6M13 9v6"/></svg></button>`;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.act === 'eye') {
        hideDrawings = !hideDrawings;
        b.classList.toggle('active', hideDrawings);
        dirty = true;
      } else if (b.dataset.act === 'trash') {
        if (!drawings.length) return;
        drawings = [];
        selected = null;
        saveDrawings();
        dirty = true;
      }
    });
  }

  const ptOf = (p) => {
    const x = timeToX(p.t), y = priceToY(p.p);
    return x == null || y == null ? null : { x, y };
  };

  function drawLabelBox(text, x, y, fg, bg) {
    ctx.font = '11px Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, 18);
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y + 9.5);
    return w;
  }

  function renderDrawing(d, sel, preview) {
    const { plotW, paneH } = plotSize();
    const col = d.color || DRAW_COLORS[d.type] || '#4aa3ff';
    ctx.lineWidth = sel ? 2 : 1.4;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    const a = d.p1 && ptOf(d.p1), b = d.p2 && ptOf(d.p2);
    const handle = (p) => {
      if (!p || !sel) return;
      ctx.fillStyle = '#0e1116';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, 7);
      ctx.fill();
      ctx.stroke();
    };
    switch (d.type) {
      case 'hline': {
        if (!a) return;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(plotW, a.y); ctx.stroke();
        const txt = fmtP(d.p1.p);
        drawLabelBox(txt, plotW - ctx.measureText(txt).width - 14, a.y - 20, '#0e1116', col);
        handle({ x: a.x, y: a.y });
        break;
      }
      case 'trend':
      case 'ray': {
        if (!a || !b) return;
        let ex = b.x, ey = b.y;
        if (d.type === 'ray' && b.x !== a.x) {
          const k = (b.y - a.y) / (b.x - a.x);
          ex = b.x > a.x ? plotW + 50 : -50;
          ey = a.y + k * (ex - a.x);
        }
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
        handle(a); handle(b);
        break;
      }
      case 'rect': {
        if (!a || !b) return;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        handle(a); handle(b);
        break;
      }
      case 'fib': {
        if (!a || !b) return;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(plotW, a.x, b.x);
        ctx.font = '10.5px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        FIB.forEach(([r, c], i) => {
          const price = d.p2.p + (d.p1.p - d.p2.p) * r;
          const y = priceToY(price);
          if (y == null) return;
          ctx.strokeStyle = c; ctx.fillStyle = c;
          ctx.globalAlpha = 0.85;
          ctx.setLineDash(r === 0 || r === 1 ? [] : [4, 3]);
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillText(`${r} (${fmtP(price)})`, x0 + 4, y - 2);
          const nxt = FIB[i + 1];
          if (nxt && r < 1) {
            const y2 = priceToY(d.p2.p + (d.p1.p - d.p2.p) * nxt[0]);
            if (y2 != null) { ctx.globalAlpha = 0.05; ctx.fillRect(x0, Math.min(y, y2), x1 - x0, Math.abs(y2 - y)); ctx.globalAlpha = 1; }
          }
        });
        ctx.setLineDash([]);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.globalAlpha = 1;
        handle(a); handle(b);
        break;
      }
      case 'measure': {
        if (!a || !b) return;
        const up = d.p2.p >= d.p1.p;
        const c = up ? GREEN : RED;
        ctx.fillStyle = c; ctx.strokeStyle = c;
        ctx.globalAlpha = 0.14;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.globalAlpha = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.setLineDash([]);
        const dp = d.p2.p - d.p1.p, pct = (dp / d.p1.p) * 100;
        const nb = Math.round(timeToIdx(d.p2.t) - timeToIdx(d.p1.t));
        const txt = `${U.fmtS(dp, dec)} (${U.fmtPct(pct)})  ·  ${nb} bars  ·  ${U.fmtDur(Math.abs(d.p2.t - d.p1.t) * 1000)}`;
        ctx.font = '11px Inter, system-ui, sans-serif';
        const w = ctx.measureText(txt).width + 14;
        const bx = (a.x + b.x) / 2 - w / 2, by = up ? Math.min(a.y, b.y) - 26 : Math.max(a.y, b.y) + 8;
        drawLabelBox(txt, bx, by, '#fff', c);
        break;
      }
    }
    ctx.setLineDash([]);
  }

  function drawAll() {
    const { w, h, plotW, paneH } = plotSize();
    const dpr = window.devicePixelRatio || 1;
    if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
      cvs.style.width = w + 'px';
      cvs.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, paneH);
    ctx.clip();
    if (!hideDrawings) drawings.forEach((d) => renderDrawing(d, d === selected));
    if (pending) renderDrawing(pending, true, true);
    if (measure) renderDrawing(measure, false);
    ctx.restore();
  }

  /* hit testing for drawings (cursor mode) */
  function distSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }
  function hitDrawing(x, y) {
    if (hideDrawings) return null;
    const { plotW } = plotSize();
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      const a = d.p1 && ptOf(d.p1), b = d.p2 && ptOf(d.p2);
      if (d.type === 'hline') {
        if (a && Math.abs(a.y - y) < 6) return { d, part: 'body' };
        continue;
      }
      if (!a || !b) continue;
      if (Math.hypot(x - a.x, y - a.y) < 8) return { d, part: 'p1' };
      if (Math.hypot(x - b.x, y - b.y) < 8) return { d, part: 'p2' };
      if (d.type === 'trend' || d.type === 'ray') {
        let e = b;
        if (d.type === 'ray' && b.x !== a.x) {
          const k = (b.y - a.y) / (b.x - a.x);
          const ex = b.x > a.x ? plotW + 50 : -50;
          e = { x: ex, y: a.y + k * (ex - a.x) };
        }
        if (distSeg(x, y, a, e) < 6) return { d, part: 'body' };
      } else if (d.type === 'rect') {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        if (x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4) return { d, part: 'body' };
      } else if (d.type === 'fib') {
        const x0 = Math.min(a.x, b.x);
        if (x >= x0 - 4) {
          for (const [r] of FIB) {
            const ly = priceToY(d.p2.p + (d.p1.p - d.p2.p) * r);
            if (ly != null && Math.abs(ly - y) < 5) return { d, part: 'body' };
          }
        }
      }
    }
    return null;
  }

  function startDrawDrag(hit, e) {
    const r = wrap.getBoundingClientRect();
    selected = hit.d;
    dirty = true;
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    dragD = {
      d: hit.d, part: hit.part,
      l0: chart.timeScale().coordinateToLogical(x0), p0: yToPrice(y0),
      o1: hit.d.p1 && { i: timeToIdx(hit.d.p1.t), p: hit.d.p1.p },
      o2: hit.d.p2 && { i: timeToIdx(hit.d.p2.t), p: hit.d.p2.p },
    };
    const move = (ev) => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const l = chart.timeScale().coordinateToLogical(x), p = yToPrice(y);
      if (l == null || p == null) return;
      const D = dragD;
      if (D.part === 'body') {
        const di = l - D.l0, dp = p - D.p0;
        D.d.p1 = { t: idxToTime(D.o1.i + di), p: D.o1.p + dp };
        if (D.o2) D.d.p2 = { t: idxToTime(D.o2.i + di), p: D.o2.p + dp };
      } else {
        D.d[D.part] = { t: idxToTime(l), p };
      }
      dirty = true;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dragD = null;
      saveDrawings();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onCanvasDown(e) {
    // active drawing tool
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = xToTime(x), p = yToPrice(y);
    if (t == null || p == null) return;
    e.preventDefault();
    if (tool === 'hline') {
      drawings.push({ id: U.uid(), type: 'hline', p1: { t, p: snapPx(p) } });
      saveDrawings();
      setTool('cursor');
      return;
    }
    if (!pending) {
      pending = { id: U.uid(), type: tool, p1: { t, p }, p2: { t, p }, _x: x, _y: y, _drag: false };
      dirty = true;
      return;
    }
    finishPending(t, p);
  }
  function finishPending(t, p) {
    pending.p2 = { t, p };
    const d = pending;
    pending = null;
    delete d._x; delete d._y; delete d._drag;
    if (d.type === 'measure') {
      measure = d;
      setTool('cursor');
      measure = d;
    } else {
      drawings.push(d);
      saveDrawings();
      setTool('cursor');
      selected = d;
    }
    dirty = true;
  }
  function onCanvasMove(e) {
    if (!pending) return;
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = xToTime(x), p = yToPrice(y);
    if (t == null || p == null) return;
    pending.p2 = { t, p };
    if (Math.hypot(x - pending._x, y - pending._y) > 6) pending._drag = true;
    dirty = true;
  }
  function onCanvasUp(e) {
    if (!pending || !pending._drag) return;
    const r = wrap.getBoundingClientRect();
    const t = xToTime(e.clientX - r.left), p = yToPrice(e.clientY - r.top);
    if (t != null && p != null) finishPending(t, p);
  }

  /* =========================================================== init */
  CV.init = () => {
    wrap = U.$('#chart-wrap');
    const host = U.$('#chart');
    tagsEl = U.$('#chart-tags');
    cvs = U.$('#draw-canvas');
    ctx = cvs.getContext('2d');
    legendEl = U.$('#chart-legend');

    chart = LW.createChart(host, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: '#0e1116' },
        textColor: '#8a94a3',
        fontSize: 11,
        fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif",
        panes: { separatorColor: '#232b36', separatorHoverColor: '#33404f', enableResize: true },
      },
      grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      crosshair: {
        mode: LW.CrosshairMode.Normal,
        vertLine: { color: '#556070', labelBackgroundColor: '#2b3340', style: 3 },
        horzLine: { color: '#556070', labelBackgroundColor: '#2b3340', style: 3 },
      },
      rightPriceScale: { borderColor: '#232b36', scaleMargins: { top: 0.1, bottom: 0.2 } },
      timeScale: { borderColor: '#232b36', timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 7, minBarSpacing: 0.4, tickMarkFormatter: tickFmt },
      localization: { timeFormatter: timeFmt },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    candleS = chart.addSeries(LW.CandlestickSeries, {
      upColor: GREEN, downColor: RED, wickUpColor: GREEN, wickDownColor: RED, borderVisible: false,
      priceLineWidth: 1, priceLineStyle: 2,
      autoscaleInfoProvider: (orig) => {
        const r = orig();
        if (!r || !candles.length) return r;
        const last = candles[candles.length - 1].close;
        lines.forEach((l) => {
          if (l.autoscale && Math.abs(l.price / last - 1) < 0.12) {
            r.priceRange.minValue = Math.min(r.priceRange.minValue, l.price);
            r.priceRange.maxValue = Math.max(r.priceRange.maxValue, l.price);
          }
        });
        return r;
      },
    });
    volS = chart.addSeries(LW.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !candles.length) {
        if (hoverIdx != null) { hoverIdx = null; renderLegend(); }
        return;
      }
      let lo = 0, hi = candles.length - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (candles[m].time < param.time) lo = m + 1; else hi = m;
      }
      hoverIdx = lo;
      renderLegend();
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => (dirty = true));

    buildDrawToolbar();
    applyIndPrefs();

    /* --- mouse: order-line + drawing interaction (capture phase, before the chart sees it) --- */
    const rel = (e) => {
      const r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    wrap.addEventListener('mousemove', (e) => {
      if (placing) return placeMove(e.clientY - wrap.getBoundingClientRect().top);
      if (drag || dragD) return;
      const { x, y } = rel(e);
      const l = e.target.closest && e.target.closest('.tag') ? null : lineAt(x, y);
      const hd = !l && tool === 'cursor' ? hitDrawing(x, y) : null;
      wrap.classList.toggle('hit-line', !!l && !!l.drag);
      wrap.classList.toggle('hit-draw', !!hd || (!!l && !l.drag));
      if (pending) onCanvasMove(e);
    }, true);
    wrap.addEventListener('mousedown', (e) => {
      if (placing && e.button === 0 && !e.target.closest('.tag')) {
        const { x: px } = rel(e);
        if (px < plotSize().plotW) {
          e.stopImmediatePropagation();
          e.preventDefault();
          placeCommit();
          return;
        }
      }
      if (e.button !== 0 || e.target.closest('.tag') || e.target.closest('#chart-legend')) return;
      const { x, y } = rel(e);
      if (tool !== 'cursor') return;
      const l = lineAt(x, y);
      if (l) {
        e.stopImmediatePropagation();
        e.preventDefault();
        startLineDrag(l, e);
        return;
      }
      const hd = hitDrawing(x, y);
      if (hd) {
        e.stopImmediatePropagation();
        e.preventDefault();
        startDrawDrag(hd, e);
        return;
      }
      if (selected) { selected = null; dirty = true; }
      if (measure) { measure = null; dirty = true; }
    }, true);
    cvs.addEventListener('mousedown', onCanvasDown);
    cvs.addEventListener('mousemove', onCanvasMove);
    cvs.addEventListener('mouseup', onCanvasUp);

    // tags: drag handle + buttons
    tagsEl.addEventListener('mousedown', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag || e.button !== 0 || e.target.closest('button')) return;
      const l = lines.get(tag.dataset.key);
      if (l && (l.drag || l.click)) {
        e.preventDefault();
        startLineDrag(l, e);
      }
    });
    tagsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const l = lines.get(b.closest('.tag').dataset.key);
      if (!l) return;
      const a = Engine.active();
      const act = b.dataset.act;
      if (act === 'remove' && l.onRemove) {
        const r = l.onRemove();
        if (r && !r.ok) U.toast(r.error, 'err');
      } else if (act === 'menu') {
        const rc = b.getBoundingClientRect();
        (l.menu || l.click)({ clientX: rc.left, clientY: rc.bottom + 4 });
      } else if (act === 'buy' || act === 'sell') {
        l.onSide && l.onSide(act);
      } else if (act === 'pct') {
        pctPopover(b, l);
      } else if (act === 'close' && a) {
        const r = Engine.closePosition(a.id, market.sym);
        if (r && !r.ok) U.toast(r.error, 'err');
        else if (r && r.filled) U.toast(`Closed ${market.sym} @ ${fmtP(r.px)}`, 'ok');
      }
    });

    /* --- context menu --- */
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (placing) return cancelPlacing();
      const { x, y } = rel(e);
      const { plotW, paneH } = plotSize();
      if (x > plotW || y > paneH || !market) return;
      const price = snapPx(yToPrice(y));
      const mark = Engine.price(market.sym);
      const a = Engine.active();
      const pos = a && a.positions[market.sym];
      const hd = hitDrawing(x, y);
      const items = [{ head: `${market.sym} @ ${fmtP(price)}` }];
      items.push({ label: `<span class="up">▲</span> Buy ${price < mark ? 'limit' : 'stop'} @ ${fmtP(price)}`, onClick: () => U.emit('chart:quickorder', { side: 'buy', price }) });
      items.push({ label: `<span class="down">▼</span> Sell ${price > mark ? 'limit' : 'stop'} @ ${fmtP(price)}`, onClick: () => U.emit('chart:quickorder', { side: 'sell', price }) });
      if (pos) {
        items.push({ sep: true });
        const tryIt = (r) => r && !r.ok && U.toast(r.error, 'err');
        const ref = { kind: 'pos', sym: market.sym };
        items.push({ label: `Add take-profit @ ${fmtP(price)}`, onClick: () => tryIt(Engine.tpAdd(a.id, ref, price)) });
        if (!pos.sl) items.push({ label: `Set stop-loss @ ${fmtP(price)}`, onClick: () => tryIt(Engine.slSet(a.id, ref, price)) });
      }
      items.push({ sep: true });
      items.push({ label: 'Add horizontal line', onClick: () => { drawings.push({ id: U.uid(), type: 'hline', p1: { t: xToTime(x) || candles[candles.length - 1].time, p: price } }); saveDrawings(); dirty = true; } });
      if (hd) items.push({ label: 'Delete drawing', cls: 'danger', onClick: () => { drawings = drawings.filter((d) => d !== hd.d); selected = null; saveDrawings(); dirty = true; } });
      items.push({ label: 'Copy price', onClick: () => navigator.clipboard && navigator.clipboard.writeText(String(price)) });
      U.menu(e.clientX, e.clientY, items);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && placing) cancelPlacing();
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        drawings = drawings.filter((d) => d !== selected);
        selected = null;
        saveDrawings();
        dirty = true;
      }
      if (e.key === 'Escape') {
        pending = null;
        measure = null;
        if (tool !== 'cursor') setTool('cursor');
        dirty = true;
      }
    });

    new ResizeObserver(() => (dirty = true)).observe(wrap);
    requestAnimationFrame(frame);
    setInterval(() => visible && layoutTags(), 250);
    U.on('engine:change', () => CV.syncTrade());
    U.on('engine:account', () => CV.syncTrade());
  };

  /* --- frame loop: re-layout overlays only when the chart geometry changed --- */
  let sig = '';
  function frame() {
    requestAnimationFrame(frame);
    if (!visible || !chart || !candles.length) return;
    const lr = chart.timeScale().getVisibleLogicalRange();
    const ref = candles[candles.length - 1].close;
    const s = [lr ? lr.from.toFixed(3) + lr.to.toFixed(3) : '', priceToY(ref), priceToY(ref * 1.01), wrap.clientWidth, wrap.clientHeight, drag ? 1 : 0].join('|');
    if (s !== sig) {
      sig = s;
      dirty = true;
      layoutTags();
    }
    if (dirty) {
      dirty = false;
      drawAll();
    }
  }

  CV.setVisible = (v) => {
    visible = v;
    if (v) {
      dirty = true;
      sig = '';
    }
  };
  CV.resize = () => (dirty = true);
  CV.screenshot = () => {
    const c = chart.takeScreenshot();
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${market.sym}_${interval}_${Date.now()}.png`;
      a.click();
    });
  };
  CV.resetView = () => {
    const n = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - 150), to: n + 12 });
    chart.priceScale('right').applyOptions({ autoScale: true });
  };
  CV.indMenu = () => Object.keys(getInds()).map((k) => ({ key: k, on: !!getInds()[k], label: k === 'vol' ? 'Volume' : INDS[k].label, sub: k === 'vol' ? '' : INDS[k].sub }));
})();
