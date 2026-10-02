/* SimEx – trade view: symbol bar, chart toolbar, order book, order form, tables, account panel */
(function () {
  const T = (window.TradeUI = {});
  const $ = U.$, $$ = U.$$;

  let sym = 'BTCUSDT', interval = '1m';
  let lastPx = 0, lastDir = 0;
  let recentTrades = [];
  let bookTab = 'book', bottomTab = 'positions', bookUnit = 'coin';
  const form = { tab: 'market', unit: 'usdt', tpsl: false, ro: false, tps: [{ price: '', pct: 100 }] };

  const M = () => Feed.bySym[sym];
  const A = () => Engine.active();
  const pdec = (p) => U.pxDec(p || lastPx || Feed.mid(sym), M() ? M().szDec : 2);
  const fmtP = (p, d) => U.fmt(p, d == null ? pdec(p) : d);
  const hue = (s) => {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  };
  const coinIcon = (base) => `<span class="coin-ic" style="background:hsl(${hue(base)},55%,42%)">${U.esc(base.replace(/^1000/, '').slice(0, 1))}</span>`;

  const tpsSummary = (h, d) => {
    const tps = h.tps || [];
    const t = tps.length
      ? tps.slice(0, 2).map((x) => U.fmt(x.price, d) + (tps.length > 1 || x.pct < 100 ? ` <i class="pc">${+(+x.pct).toFixed(0)}%</i>` : '')).join(', ') + (tps.length > 2 ? ` +${tps.length - 2}` : '')
      : '--';
    return `<span class="up">${t}</span> / <span class="down">${h.sl ? U.fmt(h.sl, d) : '--'}</span>`;
  };
  const syncChart = () => window.ChartView && ChartView.syncTrade && ChartView.syncTrade();
  T.sym = () => sym;
  T.interval = () => interval;

  /* ------------------------------------------------------------------ popover helper */
  let popEl = null;
  function closePopover() {
    if (popEl) popEl.remove();
    popEl = null;
  }
  function popover(anchor, html, { align = 'left', cls = '' } = {}) {
    closePopover();
    popEl = U.el(`<div class="popover ${cls}">${html}</div>`);
    document.body.append(popEl);
    const r = anchor.getBoundingClientRect();
    const pw = popEl.offsetWidth;
    popEl.style.top = r.bottom + 6 + 'px';
    popEl.style.left = Math.max(8, Math.min(innerWidth - pw - 8, align === 'right' ? r.right - pw : r.left)) + 'px';
    return popEl;
  }
  document.addEventListener('mousedown', (e) => {
    if (popEl && !popEl.contains(e.target) && !e.target.closest('[data-pop]')) closePopover();
  });
  T.popover = popover;
  T.closePopover = closePopover;

  /* ------------------------------------------------------------------ symbol bar */
  function renderSymbar() {
    const m = M();
    $('#symbar').innerHTML = `
      <button class="sb-sym" id="sb-sym-btn" data-pop>
        ${coinIcon(m.base)}
        <div class="sb-name"><b>${m.sym}</b><span>Perpetual <i class="lev-badge">${m.maxLev}x</i></span></div>
        <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
      <div class="sb-price"><b id="sb-last">–</b><span id="sb-chg">–</span></div>
      <div class="sb-stats">
        <div class="sb-stat"><label>Mark</label><span id="sb-mark">–</span></div>
        <div class="sb-stat"><label>Index</label><span id="sb-index">–</span></div>
        <div class="sb-stat"><label>Funding / Countdown</label><span id="sb-fund">–</span></div>
        <div class="sb-stat"><label>24h Volume (USDT)</label><span id="sb-vol">–</span></div>
        <div class="sb-stat"><label>Open Interest (USDT)</label><span id="sb-oi">–</span></div>
      </div>`;
    $('#sb-sym-btn').onclick = openSymbolPicker;
  }

  function updateSymbar() {
    const m = M();
    if (!m) return;
    const c = Feed.ctx[sym] || {};
    const px = lastPx || Feed.mid(sym);
    const d = pdec(px);
    const el = $('#sb-last');
    if (!el) return;
    el.textContent = fmtP(px, d);
    el.className = lastDir > 0 ? 'up' : lastDir < 0 ? 'down' : '';
    const chg = c.prev ? ((px - c.prev) / c.prev) * 100 : c.chg || 0;
    const chgE = $('#sb-chg');
    chgE.textContent = U.fmtPct(chg);
    chgE.className = U.cls(chg);
    $('#sb-mark').textContent = fmtP(c.mark, d);
    $('#sb-index').textContent = fmtP(c.oracle, d);
    const now = Date.now();
    const next = Math.ceil((now + 1) / 3600e3) * 3600e3;
    const left = Math.max(0, next - now);
    $('#sb-fund').innerHTML = `<span class="${c.funding >= 0 ? 'up' : 'down'}">${(c.funding * 100).toFixed(4)}%</span> / ${U.p2(Math.floor(left / 3600e3))}:${U.p2(Math.floor((left % 3600e3) / 60e3))}:${U.p2(Math.floor((left % 60e3) / 1000))}`;
    $('#sb-vol').textContent = U.fmt(c.vol, 0);
    $('#sb-oi').textContent = U.fmt(c.oi, 0);
    document.title = `${fmtP(px, d)} ${m.sym} · SimEx`;
  }

  /* ------------------------------------------------------------------ symbol picker */
  function openSymbolPicker() {
    const html = `<div class="sp"><input id="sp-q" placeholder="Search pair…" autocomplete="off"><div class="sp-head"><span>Pair</span><span>Last</span><span>24h</span><span>Volume</span></div><div class="sp-list" id="sp-list"></div></div>`;
    const p = popover($('#sb-sym-btn'), html, { cls: 'wide' });
    const list = $('#sp-list', p);
    const build = (q) => {
      q = q.trim().toUpperCase();
      const rows = Feed.markets
        .filter((m) => !q || m.sym.includes(q) || m.coin.toUpperCase().includes(q))
        .sort((a, b) => ((Feed.ctx[b.sym] || {}).vol || 0) - ((Feed.ctx[a.sym] || {}).vol || 0))
        .slice(0, 150);
      list.innerHTML = rows
        .map((m) => {
          const c = Feed.ctx[m.sym] || {};
          return `<div class="sp-row ${m.sym === sym ? 'cur' : ''}" data-sym="${m.sym}"><span class="sp-n">${coinIcon(m.base)}<b>${m.base}</b><i>USDT</i><em>${m.maxLev}x</em></span><span>${fmtP(c.mark, U.pxDec(c.mark, m.szDec))}</span><span class="${U.cls(c.chg)}">${U.fmtPct(c.chg)}</span><span>${U.fmtCompact(c.vol)}</span></div>`;
        })
        .join('');
    };
    build('');
    const q = $('#sp-q', p);
    q.focus();
    q.oninput = () => build(q.value);
    q.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const f = $('.sp-row', p);
        if (f) {
          T.select(f.dataset.sym);
          closePopover();
        }
      }
    };
    list.onclick = (e) => {
      const r = e.target.closest('.sp-row');
      if (r) {
        T.select(r.dataset.sym);
        closePopover();
      }
    };
  }

  /* ------------------------------------------------------------------ chart toolbar */
  const MAIN_IV = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  const MORE_IV = ['3m', '30m', '2h', '8h', '12h', '3d'];
  const ivLabel = (iv) => iv.replace(/m$/, 'm').replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');

  function renderChartToolbar() {
    const extra = MORE_IV.includes(interval) ? `<button class="tf active" data-iv="${interval}">${ivLabel(interval)}</button>` : '';
    $('#chart-toolbar').innerHTML = `
      <div class="tf-group">${MAIN_IV.map((iv) => `<button class="tf ${iv === interval ? 'active' : ''}" data-iv="${iv}">${ivLabel(iv)}</button>`).join('')}${extra}
        <button class="tf" id="tf-more" data-pop title="More timeframes">▾</button></div>
      <span class="tb-sep"></span>
      <button class="tb-btn" id="tb-ind" data-pop><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 14l4-5 3 3 4-6 5 4"/></svg>Indicators</button>
      <div class="spacer"></div>
      <span class="tb-hint">Right-click chart for quick orders · drag TP / SL / order lines</span>
      <button class="tb-btn icon" id="tb-reset" title="Reset view"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a6 6 0 1 0 2-4.5M4 3v4h4"/></svg></button>
      <button class="tb-btn icon" id="tb-shot" title="Screenshot"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6h3l1.5-2h5L14 6h3v10H3z"/><circle cx="10" cy="11" r="3"/></svg></button>
      <button class="tb-btn icon" id="tb-fs" title="Fullscreen"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/></svg></button>`;
    const tb = $('#chart-toolbar');
    tb.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.iv) T.select(sym, b.dataset.iv);
      else if (b.id === 'tf-more')
        popover(b, `<div class="menu-list">${MORE_IV.map((iv) => `<div class="mi" data-iv="${iv}">${ivLabel(iv)}</div>`).join('')}</div>`).onclick = (ev) => {
          const i = ev.target.closest('[data-iv]');
          if (i) { T.select(sym, i.dataset.iv); closePopover(); }
        };
      else if (b.id === 'tb-ind') {
        const draw = () => {
          const p = popover(b, `<div class="menu-list">${ChartView.indMenu().map((i) => `<label class="mi chk"><input type="checkbox" data-k="${i.key}" ${i.on ? 'checked' : ''}><span>${i.label}</span><em>${i.sub}</em></label>`).join('')}</div>`);
          p.onchange = (ev) => ChartView.toggleInd(ev.target.dataset.k);
        };
        draw();
      } else if (b.id === 'tb-reset') ChartView.resetView();
      else if (b.id === 'tb-shot') ChartView.screenshot();
      else if (b.id === 'tb-fs') {
        $('#chart-panel').classList.toggle('fs');
        ChartView.resize();
      }
    };
  }

  /* ------------------------------------------------------------------ select symbol / interval */
  T.select = (s, iv) => {
    if (!Feed.bySym[s]) return;
    const symChanged = s !== sym;
    sym = s;
    if (iv) interval = iv;
    Engine.setPref('symbol', sym);
    Engine.setPref('interval', interval);
    if (symChanged) {
      recentTrades = [];
      lastPx = Feed.mid(sym);
      lastDir = 0;
      renderSymbar();
      renderOrderPanel();
    }
    renderChartToolbar();
    renderBookShell();
    ChartView.load(sym, interval);
    renderBottom();
    updateAll();
  };

  /* ------------------------------------------------------------------ order book / trades */
  function renderBookShell() {
    const m = M();
    $('#book-panel').innerHTML = `
      <div class="bk-tabs"><button data-t="book" class="${bookTab === 'book' ? 'active' : ''}">Order Book</button><button data-t="trades" class="${bookTab === 'trades' ? 'active' : ''}">Recent Trades</button>
        <div class="spacer"></div><button class="bk-unit" id="bk-unit" title="Toggle size unit">${bookUnit === 'coin' ? m.base : 'USDT'}</button></div>
      <div class="bk-head"><span>Price (USDT)</span><span>Size (${bookUnit === 'coin' ? m.base : 'USDT'})</span><span>${bookTab === 'book' ? 'Total' : 'Time'}</span></div>
      <div class="bk-body" id="bk-body"></div>`;
    $('.bk-tabs').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.t) { bookTab = b.dataset.t; renderBookShell(); }
      else if (b.id === 'bk-unit') { bookUnit = bookUnit === 'coin' ? 'usdt' : 'coin'; renderBookShell(); }
    };
    $('#bk-body').onclick = (e) => {
      const r = e.target.closest('[data-px]');
      if (!r) return;
      setFormTab('limit');
      $('#op-price').value = r.dataset.px;
      updateOrderInfo();
    };
    renderBook();
  }

  let bookRaf = 0;
  function scheduleBook() {
    if (bookRaf) return;
    bookRaf = setTimeout(() => {
      bookRaf = 0;
      renderBook();
    }, 120);
  }
  function renderBook() {
    const body = $('#bk-body');
    const m = M();
    if (!body || !m) return;
    const d = pdec(lastPx || Feed.mid(sym));
    const sz = (q, px) => (bookUnit === 'coin' ? U.fmt(q, Math.min(m.szDec, 4)) : U.fmtCompact(q * px));
    if (bookTab === 'trades') {
      body.innerHTML = recentTrades
        .slice(0, 60)
        .map((t) => `<div class="bk-row tr"><span class="${t.side === 'buy' ? 'up' : 'down'}">${fmtP(t.px, d)}</span><span>${sz(t.sz, t.px)}</span><span class="dim">${U.fmtTime(t.time)}</span></div>`)
        .join('');
      return;
    }
    const b = Feed.books[m.coin];
    if (!b) {
      body.innerHTML = '<div class="empty-note">Waiting for order book…</div>';
      return;
    }
    const h = body.clientHeight || 300;
    const n = U.clamp(Math.floor((h - 44) / 2 / 20), 4, 16);
    const asks = b.asks.slice(0, n), bids = b.bids.slice(0, n);
    let cum = 0;
    const askRows = asks.map((l) => ({ ...l, cum: (cum += l.sz) }));
    cum = 0;
    const bidRows = bids.map((l) => ({ ...l, cum: (cum += l.sz) }));
    const maxCum = Math.max(askRows.length ? askRows[askRows.length - 1].cum : 0, bidRows.length ? bidRows[bidRows.length - 1].cum : 0, 1e-9);
    const row = (l, cls) =>
      `<div class="bk-row ${cls}" data-px="${l.px}"><i style="width:${((l.cum / maxCum) * 100).toFixed(1)}%"></i><span>${fmtP(l.px, d)}</span><span>${sz(l.sz, l.px)}</span><span>${sz(l.cum, l.px)}</span></div>`;
    const spread = asks.length && bids.length ? asks[0].px - bids[0].px : 0;
    const c = Feed.ctx[sym] || {};
    body.innerHTML =
      askRows.slice().reverse().map((l) => row(l, 'ask')).join('') +
      `<div class="bk-mid"><b class="${lastDir >= 0 ? 'up' : 'down'}">${fmtP(lastPx || Feed.mid(sym), d)} ${lastDir > 0 ? '↑' : lastDir < 0 ? '↓' : ''}</b><span class="dim">${fmtP(c.mark, d)}</span><span class="dim">Spr ${fmtP(spread, d)}</span></div>` +
      bidRows.map((l) => row(l, 'bid')).join('');
  }

  U.on('feed:book', (coin) => M() && coin === M().coin && bookTab === 'book' && scheduleBook());
  U.on('feed:trades', (coin, rows) => {
    if (!M() || coin !== M().coin) return;
    rows.forEach((t) => {
      if (lastPx) lastDir = t.px > lastPx ? 1 : t.px < lastPx ? -1 : lastDir;
      lastPx = t.px;
      recentTrades.unshift(t);
      Engine.onPrice(sym, t.px, t.time, { src: 'trade' });
    });
    if (recentTrades.length > 80) recentTrades.length = 80;
    if (bookTab === 'trades') scheduleBook();
  });

  /* ------------------------------------------------------------------ order panel */
  function renderOrderPanel() {
    const m = M();
    if (!m) return;
    const a = A();
    const st = a ? Engine.levSetting(a, sym) : { lev: 10, mode: 'cross' };
    const keepSize = form.keepSize;
    $('#order-panel').innerHTML = `
      <div class="op-top">
        <button class="op-sel" id="op-mode" data-pop>${st.mode === 'cross' ? 'Cross' : 'Isolated'}</button>
        <button class="op-sel" id="op-lev" data-pop>${st.lev}x</button>
      </div>
      <div class="op-tabs">
        <button data-tab="market">Market</button><button data-tab="limit">Limit</button><button data-tab="stop">Stop Market</button>
      </div>
      <div class="op-avbl"><span>Avbl</span><b id="op-avbl">0.00 USDT</b><button class="mini-plus" id="op-dep" title="Deposit">+</button></div>
      <div class="field" id="fld-price"><label>Price</label><input id="op-price" inputmode="decimal" autocomplete="off" placeholder="0.0"><span class="unit">USDT</span><button class="mini" id="op-last" title="Use last price">Last</button></div>
      <div class="field" id="fld-mkt"><label>Price</label><input value="Market price" disabled><span class="unit">USDT</span></div>
      <div class="field"><label>Size</label><input id="op-size" inputmode="decimal" autocomplete="off" placeholder="0.0"><select id="op-unit"><option value="usdt">USDT</option><option value="coin">${U.esc(m.base)}</option><option value="margin">Margin</option></select></div>
      <div class="op-slider"><input type="range" id="op-slider" min="0" max="100" step="1" value="0"><div class="op-pct"><span id="op-pct">0</span>%</div></div>
      <div class="op-chks">
        <label class="chk"><input type="checkbox" id="op-tpsl"><span>TP/SL</span></label>
        <label class="chk"><input type="checkbox" id="op-ro"><span>Reduce-Only</span></label>
      </div>
      <div id="op-tpsl-box" class="op-tpsl" hidden>
        <div id="op-tp-rows"></div>
        <button class="link-btn" id="op-tp-add" type="button">+ Add partial take-profit</button>
        <div class="field sm"><label class="down">SL</label><input id="op-sl" inputmode="decimal" placeholder="Stop-loss price" autocomplete="off"><span class="unit" id="op-sl-hint"></span></div>
        <div class="op-risk" id="op-risk"></div>
      </div>
      <div class="op-btns">
        <button class="buy" id="op-buy">Buy / Long</button>
        <button class="sell" id="op-sell">Sell / Short</button>
      </div>
      <div class="op-info">
        <div class="col"><div><span>Liq.Price</span><b id="i-liq-l">--</b></div><div><span>Cost</span><b id="i-cost-l">0.00</b></div><div><span>Max</span><b id="i-max-l">0.00 USDT</b></div></div>
        <div class="col r"><div><span>Liq.Price</span><b id="i-liq-s">--</b></div><div><span>Cost</span><b id="i-cost-s">0.00</b></div><div><span>Max</span><b id="i-max-s">0.00 USDT</b></div></div>
      </div>
      <div class="op-fees" id="op-fees"></div>`;
    $('#op-unit').value = form.unit;
    $('#op-tpsl').checked = form.tpsl;
    $('#op-ro').checked = form.ro;
    $('#op-tpsl-box').hidden = !form.tpsl;
    renderTpRows();
    setFormTab(form.tab, true);
    wireOrderPanel();
    updateOrderInfo();
    syncChart();
  }

  function setFormTab(t, silent) {
    form.tab = t;
    $$('#order-panel .op-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    const lim = t !== 'market';
    $('#fld-price').style.display = lim ? '' : 'none';
    $('#fld-mkt').style.display = lim ? 'none' : '';
    const pl = $('#fld-price label');
    if (pl) pl.textContent = t === 'stop' ? 'Trigger' : 'Price';
    if (lim && !$('#op-price').value) $('#op-price').value = (lastPx || Feed.mid(sym)).toFixed(pdec());
    if (!silent) {
      updateOrderInfo();
      syncChart();
    }
  }

  const num = (id) => {
    const v = parseFloat(($(id) || {}).value);
    return Number.isFinite(v) ? v : 0;
  };

  function refPrice() {
    return form.tab === 'market' ? lastPx || Feed.mid(sym) : num('#op-price') || lastPx || Feed.mid(sym);
  }
  function maxNotional(a, side, st, px) {
    const m = Engine.metrics(a);
    let n = m.avail / (1 / st.lev + a.taker);
    const pos = a.positions[sym];
    if (pos && (pos.side === 'long' ? 'sell' : 'buy') === side) n += pos.size * px; // can also close/flip
    return n;
  }
  function sizeQty() {
    const m = M();
    const a = A();
    const v = num('#op-size');
    if (!(v > 0) || !a) return 0;
    const st = Engine.levSetting(a, sym);
    const px = refPrice();
    const unit = $('#op-unit').value;
    const q = unit === 'usdt' ? v / px : unit === 'coin' ? v : (v * st.lev) / px;
    return U.floorTo(q, m.szDec);
  }

  function wireOrderPanel() {
    const op = $('#order-panel');
    op.querySelector('.op-tabs').onclick = (e) => {
      const b = e.target.closest('button');
      if (b) setFormTab(b.dataset.tab);
    };
    $('#op-unit').onchange = (e) => {
      form.unit = e.target.value;
      $('#op-size').value = '';
      $('#op-slider').value = 0;
      updateOrderInfo();
    };
    $('#op-tpsl').onchange = (e) => {
      form.tpsl = e.target.checked;
      $('#op-tpsl-box').hidden = !form.tpsl;
      updateOrderInfo();
      syncChart();
    };
    $('#op-ro').onchange = (e) => (form.ro = e.target.checked);
    $('#op-last').onclick = () => {
      $('#op-price').value = (lastPx || Feed.mid(sym)).toFixed(pdec());
      updateOrderInfo();
      syncChart();
    };
    $('#op-dep').onclick = () => Accounts.moneyDialog('deposit');
    ['#op-price', '#op-size', '#op-sl'].forEach((id) => ($(id).oninput = () => {
      if (id === '#op-size') syncSliderFromSize();
      updateOrderInfo();
      syncChart();
    }));
    const rows = $('#op-tp-rows');
    rows.addEventListener('input', (e) => {
      const row = e.target.closest('.tprow');
      if (!row) return;
      const r = form.tps[+row.dataset.i];
      if (e.target.classList.contains('tp-px')) r.price = e.target.value;
      else r.pct = e.target.value;
      updateOrderInfo();
      syncChart();
    });
    rows.addEventListener('click', (e) => {
      const x = e.target.closest('.row-x');
      if (!x) return;
      form.tps.splice(+x.closest('.tprow').dataset.i, 1);
      if (!form.tps.length) form.tps.push({ price: '', pct: 100 });
      renderTpRows();
      updateOrderInfo();
      syncChart();
    });
    $('#op-tp-add').onclick = () => {
      if (form.tps.length >= 5) return U.toast('Maximum 5 take-profit levels', 'err');
      const p = nextPct(form.tps);
      if (p == null) return U.toast('No size left for another take-profit', 'err');
      form.tps.push({ price: '', pct: p });
      renderTpRows();
      const inp = rows.querySelectorAll('.tp-px');
      inp[inp.length - 1].focus();
    };
    $('#op-slider').oninput = (e) => {
      const a = A();
      if (!a) return;
      const st = Engine.levSetting(a, sym);
      const px = refPrice();
      const mx = Math.max(maxNotional(a, 'buy', st, px), maxNotional(a, 'sell', st, px));
      const notional = (mx * e.target.value) / 100;
      const unit = $('#op-unit').value;
      const v = unit === 'usdt' ? notional : unit === 'coin' ? notional / px : notional / st.lev;
      $('#op-size').value = e.target.value > 0 ? (unit === 'coin' ? U.floorTo(v, M().szDec).toString() : v.toFixed(2)) : '';
      $('#op-pct').textContent = e.target.value;
      updateOrderInfo();
      syncChart();
    };
    $('#op-buy').onclick = () => submit('buy');
    $('#op-sell').onclick = () => submit('sell');
    $('#op-mode').onclick = (e) => levDialog();
    $('#op-lev').onclick = (e) => levDialog();
  }

  function syncSliderFromSize() {
    const a = A();
    if (!a) return;
    const st = Engine.levSetting(a, sym);
    const px = refPrice();
    const mx = Math.max(maxNotional(a, 'buy', st, px), maxNotional(a, 'sell', st, px));
    const q = sizeQty();
    const pct = mx > 0 ? U.clamp(((q * px) / mx) * 100, 0, 100) : 0;
    $('#op-slider').value = pct;
    $('#op-pct').textContent = Math.round(pct);
  }

  function updateOrderInfo() {
    const a = A(), m = M();
    if (!a || !m || !$('#op-avbl')) return;
    const st = Engine.levSetting(a, sym);
    const mt = Engine.metrics(a);
    $('#op-avbl').textContent = U.fmt(mt.avail) + ' USDT';
    const px = refPrice();
    const q = sizeQty();
    const notional = q * px;
    const cost = notional / st.lev;
    const fee = notional * a.taker;
    const mxL = maxNotional(a, 'buy', st, px), mxS = maxNotional(a, 'sell', st, px);
    $('#i-cost-l').textContent = U.fmt(cost + fee * 0);
    $('#i-cost-s').textContent = U.fmt(cost);
    $('#i-max-l').textContent = U.fmt(mxL, 2) + ' USDT';
    $('#i-max-s').textContent = U.fmt(mxS, 2) + ' USDT';
    const d = pdec(px);
    const lq = (side) => (q > 0 ? Engine.estLiq(a, sym, side, q, px, st.lev, st.mode) : null);
    const ll = lq('buy'), ls = lq('sell');
    $('#i-liq-l').textContent = ll ? fmtP(ll, d) : '--';
    $('#i-liq-s').textContent = ls ? fmtP(ls, d) : '--';
    $('#op-fees').innerHTML = `<span>Fees: maker ${(a.maker * 100).toFixed(3)}% · taker ${(a.taker * 100).toFixed(3)}%</span><span>${q > 0 ? `${U.fmtQty(q, m.szDec)} ${m.base} ≈ ${U.fmt(notional)} USDT · fee ≈ ${U.fmt(fee)}` : ''}</span>`;
    // slider max label
    if (form.tpsl) {
      const rows = form.tps.map((r) => ({ price: parseFloat(r.price), pct: parseFloat(r.pct) || 0 })).filter((r) => r.price > 0);
      const sl = num('#op-sl');
      $('#op-sl-hint').textContent = sl > 0 && px ? U.fmtPct(((sl - px) / px) * 100, 2) : '';
      let risk = '';
      if (sl > 0 && q > 0) {
        const r = q * Math.abs(px - sl) + notional * (a.taker + a.taker);
        risk = `Risk at SL: <b class="down">-${U.fmt(r)} USDT</b> (${((r / mt.equity) * 100).toFixed(2)}% of equity)`;
        if (rows.length) {
          const rew = rows.reduce((x, t) => x + q * (t.pct / 100) * Math.abs(t.price - px), 0) - notional * (a.maker + a.taker);
          risk += ` · R:R <b>${(rew / r).toFixed(2)}</b>`;
        }
      }
      const tot = rows.reduce((x, t) => x + t.pct, 0);
      if (tot > 100.01) risk += `<br><b class="down">Total take-profit size is ${tot.toFixed(0)}% (max 100%)</b>`;
      else if (rows.length > 1) risk += `${risk ? '<br>' : ''}TP ladder closes ${tot.toFixed(0)}% of the position`;
      $('#op-risk').innerHTML = risk;
    }
  }

  /* ---------- TP rows (partial take-profits) + draft lines shown on the chart ---------- */
  function renderTpRows() {
    const box = $('#op-tp-rows');
    if (!box) return;
    box.innerHTML = form.tps
      .map((r, i) => `<div class="field sm tprow" data-i="${i}"><label class="up">TP${i + 1}</label><input class="tp-px" inputmode="decimal" autocomplete="off" placeholder="Take-profit price" value="${U.esc(r.price)}"><input class="tp-pct" inputmode="decimal" autocomplete="off" value="${U.esc(r.pct)}" title="% of the position closed at this level"><span class="unit">%</span>${form.tps.length > 1 ? '<button class="row-x" type="button" title="Remove">✕</button>' : ''}</div>`)
      .join('');
    $('#op-tp-add').style.display = form.tps.length >= 5 ? 'none' : '';
  }
  function nextPct(rows) {
    const sum = rows.reduce((x, r) => x + (parseFloat(r.pct) || 0), 0);
    if (sum < 99.99) return Math.round((100 - sum) * 100) / 100;
    const last = rows[rows.length - 1];
    const cur = parseFloat(last.pct) || 0;
    const half = Math.floor(cur / 2);
    if (half < 1) return null;
    last.pct = cur - half;
    return half;
  }
  const fixPx = (p) => p.toFixed(pdec(p));

  // what the chart should draw as temporary (not yet placed) lines
  T.draft = () => {
    if (!$('#op-price') || !A()) return null;
    const price = form.tab !== 'market' ? num('#op-price') : 0;
    const tps = form.tpsl ? form.tps.map((r, i) => ({ i, price: parseFloat(r.price), pct: parseFloat(r.pct) || 0 })).filter((t) => t.price > 0) : [];
    const sl = form.tpsl ? num('#op-sl') : 0;
    if (!(price > 0) && !tps.length && !(sl > 0)) return null;
    const st = Engine.levSetting(A(), sym);
    return { tab: form.tab, price, tps, sl, ref: price > 0 ? price : lastPx || Feed.mid(sym), qty: sizeQty(), lev: st.lev };
  };
  T.setDraft = (kind, i, price) => {
    if (kind === 'price') $('#op-price').value = fixPx(price);
    else if (kind === 'sl') $('#op-sl').value = fixPx(price);
    else if (kind === 'tp') form.tps[i].price = fixPx(price);
    else if (kind === 'pct') form.tps[i].pct = price;
    if (kind === 'tp' || kind === 'pct') renderTpRows();
    updateOrderInfo();
    syncChart();
    return { ok: true };
  };
  T.draftAdd = (kind, price) => {
    form.tpsl = true;
    $('#op-tpsl').checked = true;
    $('#op-tpsl-box').hidden = false;
    if (kind === 'sl') $('#op-sl').value = fixPx(price);
    else {
      const empty = form.tps.find((r) => !(parseFloat(r.price) > 0));
      if (empty) empty.price = fixPx(price);
      else {
        if (form.tps.length >= 5) return { ok: false, error: 'Maximum 5 take-profit levels' };
        const p = nextPct(form.tps);
        if (p == null) return { ok: false, error: 'No size left for another take-profit' };
        form.tps.push({ price: fixPx(price), pct: p });
      }
    }
    renderTpRows();
    updateOrderInfo();
    syncChart();
    return { ok: true };
  };
  T.draftRemove = (kind, i) => {
    if (kind === 'sl') $('#op-sl').value = '';
    else if (form.tps.length > 1) form.tps.splice(i, 1);
    else form.tps[0].price = '';
    renderTpRows();
    updateOrderInfo();
    syncChart();
  };
  const resetDraft = () => {
    form.tps = [{ price: '', pct: 100 }];
    renderTpRows();
    $('#op-sl').value = '';
  };
  T.draftCancel = () => {
    resetDraft();
    $('#op-price').value = '';
    setFormTab('market');
  };

  function submit(side) {
    const a = A(), m = M();
    if (!a) return U.toast('Create an account first', 'err');
    const q = sizeQty();
    if (!(q > 0)) {
      $('#op-size').focus();
      return U.toast('Enter an order size', 'err');
    }
    const type = form.tab;
    const price = type === 'market' ? null : num('#op-price');
    if (type !== 'market' && !(price > 0)) return U.toast('Enter a price', 'err');
    const tps = form.tpsl && !form.ro ? form.tps.map((r) => ({ price: parseFloat(r.price), pct: parseFloat(r.pct) })).filter((r) => r.price > 0) : [];
    const sl = form.tpsl && !form.ro && num('#op-sl') > 0 ? num('#op-sl') : null;
    const r = Engine.placeOrder(a.id, { sym, side, type, size: q, price, reduceOnly: form.ro, tps, sl });
    reportOrder(r, side, q, m);
    if (r.ok) {
      resetDraft();
      if (type !== 'market') $('#op-price').value = '';
      updateOrderInfo();
      syncChart();
    }
  }
  T.submit = submit;
  function reportOrder(r, side, q, m) {
    if (!r.ok) return U.toast(r.error, 'err', 5000);
    const w = side === 'buy' ? 'Bought' : 'Sold';
    if (r.filled) U.toast(`${w} ${U.fmtQty(q, m.szDec)} ${m.base} @ ${fmtP(r.px)} · fee ${U.fmt(r.fee, 3)} USDT`, side === 'buy' ? 'ok' : 'info');
    else U.toast(`${r.order.type === 'stop' ? 'Stop' : 'Limit'} ${side} placed @ ${fmtP(r.order.price)}`, 'info');
  }

  // quick order from chart context menu
  U.on('chart:quickorder', ({ side, price }) => {
    const mark = Engine.price(sym);
    const type = side === 'buy' ? (price < mark ? 'limit' : 'stop') : price > mark ? 'limit' : 'stop';
    setFormTab(type);
    $('#op-price').value = price.toFixed(pdec(price));
    syncChart();
    const q = sizeQty();
    if (q > 0) {
      const a = A();
      const r = Engine.placeOrder(a.id, { sym, side, type, size: q, price, reduceOnly: form.ro, tps: [], sl: null });
      reportOrder(r, side, q, M());
    } else {
      U.toast('Price set – enter a size and press Buy/Sell', 'info');
      $('#op-size').focus();
    }
    updateOrderInfo();
  });

  function levDialog() {
    const a = A(), m = M();
    if (!a) return;
    const st = Engine.levSetting(a, sym);
    const pos = a.positions[sym];
    let mode = st.mode, lev = st.lev;
    const body = U.el(`<div class="lev-dlg">
      <div class="seg" id="ld-mode"><button data-m="cross" class="${mode === 'cross' ? 'active' : ''}" ${pos || m.onlyIsolated ? 'disabled' : ''}>Cross</button><button data-m="isolated" class="${mode === 'isolated' ? 'active' : ''}" ${pos ? 'disabled' : ''}>Isolated</button></div>
      <p class="hint">${m.onlyIsolated ? 'This market only supports isolated margin.' : pos ? 'Margin mode can only be changed while there is no open position.' : 'Cross shares your whole balance between positions. Isolated limits the loss to the margin of that position.'}</p>
      <div class="ld-val"><button id="ld-minus">−</button><input id="ld-num" value="${lev}"><span>x</span><button id="ld-plus">+</button></div>
      <input type="range" id="ld-rng" min="1" max="${m.maxLev}" value="${lev}">
      <div class="ld-quick">${[1, 2, 3, 5, 10, 20, 25, 50, 75].filter((x) => x <= m.maxLev).concat(m.maxLev).filter((x, i, arr) => arr.indexOf(x) === i).map((x) => `<button data-l="${x}">${x}x</button>`).join('')}</div>
      <p class="hint warn">Max leverage on ${m.sym}: ${m.maxLev}x. Maintenance margin ≈ ${(Engine.mmr(sym, 1000, a, lev) * 100).toFixed(2)}% (0.5% base tier + closing fee). At ${m.maxLev}x you are liquidated after a ~${(100 / m.maxLev * 0.5).toFixed(2)}% adverse move.</p></div>`);
    const set = (v) => {
      lev = U.clamp(Math.round(v) || 1, 1, m.maxLev);
      $('#ld-num', body).value = lev;
      $('#ld-rng', body).value = lev;
    };
    body.querySelector('#ld-mode').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      mode = b.dataset.m;
      $$('#ld-mode button', body).forEach((x) => x.classList.toggle('active', x === b));
    };
    $('#ld-rng', body).oninput = (e) => set(+e.target.value);
    $('#ld-num', body).onchange = (e) => set(+e.target.value);
    $('#ld-minus', body).onclick = () => set(lev - 1);
    $('#ld-plus', body).onclick = () => set(lev + 1);
    $('.ld-quick', body).onclick = (e) => {
      const b = e.target.closest('button');
      if (b) set(+b.dataset.l);
    };
    U.modal({
      title: `${m.sym} – Margin mode & leverage`,
      width: 400,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Confirm', cls: 'primary',
          onClick: () => {
            const r = Engine.setLeverage(a.id, sym, lev, mode);
            if (!r.ok) {
              U.toast(r.error, 'err');
              return false;
            }
            renderOrderPanel();
          },
        },
      ],
    });
  }

  /* ------------------------------------------------------------------ account panel */
  function renderAcctPanel() {
    $('#acct-panel').innerHTML = `
      <div class="ap-head"><div class="ap-btns"><button class="pill-btn active" id="ap-dep">Deposit</button><button class="pill-btn" id="ap-wd">Withdraw</button><button class="pill-btn" id="ap-acc">Accounts</button></div></div>
      <div class="ap-body">
        <div class="ap-h">Account Equity</div>
        <div class="ap-row"><span>Account</span><b id="ap-name">–</b></div>
        <div class="ap-row"><span>Equity</span><b id="ap-eq">–</b></div>
        <div class="ap-row"><span>Wallet Balance</span><b id="ap-bal">–</b></div>
        <div class="ap-row"><span>Unrealized P&amp;L</span><b id="ap-upnl">–</b></div>
        <div class="ap-row"><span>Realized P&amp;L (net)</span><b id="ap-rpnl">–</b></div>
        <div class="ap-h">Margin</div>
        <div class="ap-row"><span>Margin Used</span><b id="ap-used">–</b></div>
        <div class="ap-row"><span>Available</span><b id="ap-avail">–</b></div>
        <div class="ap-row"><span>Margin Ratio</span><b id="ap-ratio">–</b></div>
        <div class="ap-row"><span>Fees paid (total)</span><b id="ap-fees">–</b></div>
        <div class="ap-row"><span>Fees maker / taker</span><b id="ap-feerate">–</b></div>
      </div>`;
    $('#ap-dep').onclick = () => Accounts.moneyDialog('deposit');
    $('#ap-wd').onclick = () => Accounts.moneyDialog('withdraw');
    $('#ap-acc').onclick = () => Accounts.manager();
  }
  function updateAcctPanel() {
    const a = A();
    if (!a || !$('#ap-eq')) return;
    const m = Engine.metrics(a);
    const realized = a.trades.reduce((s, t) => s + t.pnl, 0);
    const fees = a.trades.reduce((s, t) => s + t.fees, 0);
    $('#ap-name').innerHTML = `<i class="dotc" style="background:${a.color}"></i>${U.esc(a.name)}`;
    $('#ap-eq').textContent = U.fmt(m.equity) + ' USDT';
    $('#ap-bal').textContent = U.fmt(m.balance + m.isoMargin) + ' USDT';
    const u = $('#ap-upnl');
    u.textContent = U.fmtS(m.uPnl) + ' USDT';
    u.className = U.cls(m.uPnl);
    const r = $('#ap-rpnl');
    r.textContent = U.fmtS(realized) + ' USDT';
    r.className = U.cls(realized);
    $('#ap-used').textContent = U.fmt(m.marginUsed) + ' USDT';
    $('#ap-avail').textContent = U.fmt(m.avail) + ' USDT';
    const ratio = $('#ap-ratio');
    ratio.textContent = m.marginRatio.toFixed(2) + '%';
    ratio.className = m.marginRatio > 80 ? 'down' : m.marginRatio > 50 ? 'warn' : 'up';
    $('#ap-fees').textContent = U.fmt(fees) + ' USDT';
    $('#ap-feerate').textContent = `${(a.maker * 100).toFixed(3)}% / ${(a.taker * 100).toFixed(3)}%`;
  }

  /* ------------------------------------------------------------------ bottom tabs */
  const TABS = [
    ['positions', 'Positions'],
    ['orders', 'Open Orders'],
    ['history', 'Order History'],
    ['trades', 'Trade History'],
    ['tx', 'Transactions'],
  ];
  function renderBottom() {
    const a = A();
    const counts = { positions: a ? Object.keys(a.positions).length : 0, orders: a ? a.orders.length : 0 };
    $('#bottom-panel').innerHTML = `
      <div class="bt-tabs">${TABS.map(([k, l]) => `<button data-t="${k}" class="${k === bottomTab ? 'active' : ''}">${l}${counts[k] ? ` <i>${counts[k]}</i>` : ''}</button>`).join('')}
        <div class="spacer"></div>
        ${bottomTab === 'positions' && counts.positions ? '<button class="mini-btn danger" id="bt-closeall">Close all positions</button>' : ''}
        ${bottomTab === 'orders' && counts.orders ? '<button class="mini-btn" id="bt-cancelall">Cancel all</button>' : ''}
      </div>
      <div class="bt-body" id="bt-body">${bottomHtml()}</div>`;
    updateLive();
  }

  const th = (arr) => `<thead><tr>${arr.map((x) => `<th>${x}</th>`).join('')}</tr></thead>`;
  const sideTag = (s) => `<span class="sd ${s === 'long' || s === 'buy' ? 'long' : 'short'}">${s === 'long' ? 'Long' : s === 'short' ? 'Short' : s === 'buy' ? 'Buy' : 'Sell'}</span>`;
  const empty = (msg) => `<div class="empty"><svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="10" width="32" height="28" rx="4"/><path d="M14 20h20M14 27h12"/></svg><span>${msg}</span></div>`;

  function bottomHtml() {
    const a = A();
    if (!a) return empty('No account – create one to start trading');
    const md = (s) => Feed.bySym[s] || { szDec: 2 };
    if (bottomTab === 'positions') {
      const rows = Object.values(a.positions);
      if (!rows.length) return empty('No open positions');
      return `<table>${th(['Contract', 'Size', 'Entry Price', 'Mark Price', 'Liq. Price', 'Margin', 'Unrealized P&L (ROE)', 'Realized P&L', 'TP / SL', 'Close'])}<tbody>${rows
        .map(
          (p) => `<tr data-sym="${p.sym}">
          <td><span class="sym-link" data-act="goto">${p.sym}</span><div class="sub">${sideTag(p.side)} <span class="dim">${p.mode === 'cross' ? 'Cross' : 'Isolated'} ${p.lev}x</span></div></td>
          <td>${U.fmtQty(p.size, md(p.sym).szDec)} <span class="dim">${Feed.bySym[p.sym] ? Feed.bySym[p.sym].base : ''}</span><div class="sub dim" data-k="value"></div></td>
          <td>${fmtP(p.entry, U.pxDec(p.entry, md(p.sym).szDec))}</td>
          <td data-k="mark"></td><td data-k="liq" class="liq"></td><td data-k="margin"></td>
          <td data-k="upnl"></td><td data-k="real"></td>
          <td><span data-k="tpsl"></span> <button class="mini-btn" data-act="tpsl" title="Edit TP/SL">✎</button></td>
          <td class="acts"><button class="mini-btn" data-act="mkt">Market</button><button class="mini-btn" data-act="lmt">Limit</button></td></tr>`
        )
        .join('')}</tbody></table>`;
    }
    if (bottomTab === 'orders') {
      if (!a.orders.length) return empty('No open orders');
      return `<table>${th(['Time', 'Contract', 'Type', 'Side', 'Price', 'Qty', 'Reduce', 'TP / SL', ''])}<tbody>${a.orders
        .slice().reverse()
        .map((o) => {
          const d = U.pxDec(o.price, md(o.sym).szDec);
          return `<tr data-id="${o.id}"><td class="dim">${U.fmtDT(o.createdAt)}</td><td><span class="sym-link" data-sym="${o.sym}" data-act="goto2">${o.sym}</span></td><td>${o.type === 'stop' ? 'Stop Market' : 'Limit'}</td><td>${sideTag(o.side)}</td><td>${U.fmt(o.price, d)}</td><td>${U.fmtQty(o.size, md(o.sym).szDec)}</td><td>${o.reduceOnly ? 'Yes' : '–'}</td><td>${tpsSummary(o, d)} ${o.reduceOnly ? '' : '<button class="mini-btn" data-act="otpsl" title="Edit TP / SL of this order">✎</button>'}</td><td class="acts"><button class="mini-btn" data-act="cancel">Cancel</button></td></tr>`;
        })
        .join('')}</tbody></table>`;
    }
    if (bottomTab === 'history') {
      if (!a.orderHistory.length) return empty('No order history');
      return `<table>${th(['Time', 'Contract', 'Type', 'Side', 'Price', 'Filled @', 'Qty', 'Fee', 'Status'])}<tbody>${a.orderHistory
        .slice().reverse().slice(0, 300)
        .map((o) => {
          const d = U.pxDec(o.avgPx || o.price || 1, md(o.sym).szDec);
          return `<tr><td class="dim">${U.fmtDT(o.doneAt || o.createdAt)}</td><td>${o.sym}</td><td>${o.type === 'stop' ? 'Stop' : o.type === 'limit' ? 'Limit' : 'Market'}</td><td>${sideTag(o.side)}</td><td>${o.price ? U.fmt(o.price, d) : 'Market'}</td><td>${o.avgPx ? U.fmt(o.avgPx, d) : '–'}</td><td>${U.fmtQty(o.size, md(o.sym).szDec)}</td><td>${o.fee != null ? U.fmt(o.fee, 4) : '–'}</td><td><span class="st ${o.status}">${o.status}</span>${o.reason ? `<div class="sub dim">${U.esc(o.reason)}</div>` : ''}</td></tr>`;
        })
        .join('')}</tbody></table>`;
    }
    if (bottomTab === 'trades') {
      if (!a.trades.length) return empty('No closed trades yet');
      return `<table>${th(['Closed', 'Contract', 'Side', 'Qty', 'Entry', 'Exit', 'Fees', 'Funding', 'Net P&L', 'ROE', 'Held', 'Exit'])}<tbody>${a.trades
        .slice().reverse().slice(0, 300)
        .map((t) => {
          const d = U.pxDec(t.entry, md(t.sym).szDec);
          return `<tr><td class="dim">${U.fmtDT(t.closeTime)}</td><td>${t.sym}<div class="sub dim">${t.mode === 'cross' ? 'Cross' : 'Isolated'} ${t.lev}x</div></td><td>${sideTag(t.side)}</td><td>${U.fmtQty(t.size, md(t.sym).szDec)}</td><td>${U.fmt(t.entry, d)}</td><td>${U.fmt(t.exit, d)}</td><td>${U.fmt(t.fees, 3)}</td><td class="${U.cls(t.funding)}">${U.fmtS(t.funding, 3)}</td><td class="${U.cls(t.pnl)}"><b>${U.fmtS(t.pnl)}</b></td><td class="${U.cls(t.roe)}">${U.fmtPct(t.roe)}</td><td class="dim">${U.fmtDur(t.closeTime - t.openTime)}</td><td><span class="st ${t.reason}">${{ tp: 'Take profit', sl: 'Stop loss', liq: 'Liquidated', market: 'Market', limit: 'Limit', stop: 'Stop', manual: 'Manual' }[t.reason] || t.reason}</span></td></tr>`;
        })
        .join('')}</tbody></table>`;
    }
    if (bottomTab === 'tx') {
      if (!a.tx.length) return empty('No transactions (deposits, withdrawals, funding) yet');
      return `<table>${th(['Time', 'Type', 'Amount (USDT)', 'Note'])}<tbody>${a.tx
        .slice().reverse().slice(0, 300)
        .map((x) => `<tr><td class="dim">${U.fmtDT(x.t)}</td><td><span class="st">${x.type}</span></td><td class="${U.cls(x.amount)}">${U.fmtS(x.amount, 4)}</td><td class="dim">${U.esc(x.note || '')}</td></tr>`)
        .join('')}</tbody></table>`;
    }
    return '';
  }

  function updateLive() {
    const a = A();
    if (!a || bottomTab !== 'positions') return;
    const body = $('#bt-body');
    if (!body) return;
    const m = Engine.metrics(a);
    $$('tr[data-sym]', body).forEach((tr) => {
      const s = tr.dataset.sym;
      const p = a.positions[s], q = m.per[s];
      if (!p || !q) return;
      const d = U.pxDec(q.px, md2(s).szDec);
      const set = (k, html, cls) => {
        const el = tr.querySelector(`[data-k="${k}"]`);
        if (!el) return;
        if (el.innerHTML !== html) el.innerHTML = html;
        if (cls != null && el.dataset.c !== cls) { el.className = cls; el.dataset.c = cls; }
      };
      set('mark', U.fmt(q.px, d));
      set('liq', q.liq ? U.fmt(q.liq, d) : '--');
      set('margin', U.fmt(q.margin) + (p.mode === 'isolated' ? '' : ''));
      set('value', U.fmt(p.size * q.px) + ' USDT');
      set('upnl', `<b>${U.fmtS(q.u)}</b> USDT <span>(${U.fmtPct(q.roe)})</span>`, U.cls(q.u));
      set('real', U.fmtS(p.realized - p.fees + p.funding), U.cls(p.realized - p.fees + p.funding));
      set('tpsl', tpsSummary(p, d));
    });
  }
  const md2 = (s) => Feed.bySym[s] || { szDec: 2 };

  // Edit TP ladder + SL of an open position or of a pending order
  T.tpslDialog = (ref) => {
    const a = A();
    if (!a) return;
    let h, s2, side, entry, basis, refPx, title;
    if (ref.kind === 'pos') {
      h = a.positions[ref.sym];
      if (!h) return U.toast('No open position', 'err');
      s2 = ref.sym; side = h.side; entry = h.entry; basis = h.maxSize; refPx = Engine.price(s2);
      title = `TP / SL – ${s2} ${h.side}`;
    } else {
      h = a.orders.find((o) => o.id === ref.id);
      if (!h) return U.toast('Order not found', 'err');
      s2 = h.sym; side = h.side === 'buy' ? 'long' : 'short'; entry = h.price; basis = h.size; refPx = h.price;
      title = `TP / SL – ${h.type === 'stop' ? 'Stop' : 'Limit'} ${h.side} order`;
    }
    const dir = side === 'long' ? 1 : -1;
    const d = U.pxDec(refPx, md2(s2).szDec);
    const rows = h.tps.map((t) => ({ price: t.price, pct: t.pct }));
    const body = U.el(`<div class="form-grid">
      <div class="kv"><span>${ref.kind === 'pos' ? 'Entry price' : 'Order price'}</span><b>${sideTag(side)} ${U.fmt(entry, d)}</b></div>
      <div class="kv"><span>${ref.kind === 'pos' ? 'Mark price' : 'Order trigger'}</span><b>${U.fmt(refPx, d)}</b></div>
      <div id="td-rows"></div>
      <button class="link-btn" id="td-add" type="button">+ Add partial take-profit</button>
      <div class="kv"><span>Total take-profit size</span><b id="td-total"></b></div>
      <label class="fld"><span class="down">Stop-loss price (closes everything that is left)</span><input id="td-sl" value="${h.sl || ''}" placeholder="empty = none"></label>
      <p class="hint">${ref.kind === 'order' ? 'These levels become active as soon as the order is filled. ' : ''}Each take-profit closes its % of the position size when price reaches it. You can also drag the lines on the chart, or click the % on a line.</p></div>`);
    const draw = () => {
      $('#td-rows', body).innerHTML = rows
        .map((r, i) => `<div class="tprow-wrap"><div class="field sm tprow" data-i="${i}"><label class="up">TP${i + 1}</label><input class="tp-px" inputmode="decimal" placeholder="Price" value="${r.price || ''}"><input class="tp-pct" inputmode="decimal" value="${r.pct}"><span class="unit">%</span><button class="row-x" type="button">✕</button></div><div class="row-est" data-e="${i}"></div></div>`)
        .join('') || '<div class="hint">No take-profit set.</div>';
      $('#td-add', body).style.display = rows.length >= 5 ? 'none' : '';
      est();
    };
    const est = () => {
      let tot = 0;
      rows.forEach((r, i) => {
        tot += parseFloat(r.pct) || 0;
        const el = $(`[data-e="${i}"]`, body);
        const px = parseFloat(r.price);
        if (!el) return;
        if (px > 0) {
          const pnl = dir * basis * ((parseFloat(r.pct) || 0) / 100) * (px - entry);
          el.innerHTML = `${U.fmtPct(((px - entry) / entry) * 100, 2)} from ${ref.kind === 'pos' ? 'entry' : 'order'} · <span class="${U.cls(pnl)}">≈ ${U.fmtS(pnl)} USDT</span>`;
        } else el.textContent = '';
      });
      const t = $('#td-total', body);
      t.textContent = tot.toFixed(0) + '%';
      t.className = tot > 100.01 ? 'down' : '';
    };
    body.addEventListener('input', (e) => {
      const row = e.target.closest('.tprow');
      if (!row) return;
      const r = rows[+row.dataset.i];
      if (e.target.classList.contains('tp-px')) r.price = e.target.value;
      else r.pct = e.target.value;
      est();
    });
    body.addEventListener('click', (e) => {
      const x = e.target.closest('.row-x');
      if (x) {
        rows.splice(+x.closest('.tprow').dataset.i, 1);
        return draw();
      }
      if (e.target.id === 'td-add') {
        if (rows.length >= 5) return;
        const p = rows.length ? nextPct(rows) : 100;
        if (p == null) return U.toast('No size left for another take-profit', 'err');
        rows.push({ price: '', pct: p });
        draw();
      }
    });
    draw();
    U.modal({
      title, width: 440, body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save', cls: 'primary',
          onClick: () => {
            const tps = rows.filter((r) => parseFloat(r.price) > 0).map((r) => ({ price: parseFloat(r.price), pct: parseFloat(r.pct) }));
            const slv = parseFloat($('#td-sl', body).value);
            const r = Engine.tpslSet(a.id, ref, { tps, sl: slv > 0 ? slv : null });
            if (!r.ok) { U.toast(r.error, 'err', 5000); return false; }
            U.toast('TP / SL updated', 'ok');
          },
        },
      ],
    });
  };

  function limitCloseDialog(s) {
    const a = A();
    const p = a.positions[s];
    if (!p) return;
    const mkt = Engine.price(s);
    const d = U.pxDec(mkt, md2(s).szDec);
    let pct = 100;
    const body = U.el(`<div class="form-grid">
      <label class="fld"><span>Limit price</span><input id="lc-px" value="${mkt.toFixed(d)}"></label>
      <div class="fld"><span>Quantity</span><div class="ld-quick" id="lc-pct">${[25, 50, 75, 100].map((x) => `<button data-p="${x}" class="${x === 100 ? 'active' : ''}">${x}%</button>`).join('')}</div></div>
      <p class="hint">A reduce-only limit order will be placed. If the price is already marketable it fills immediately as taker.</p></div>`);
    $('#lc-pct', body).onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      pct = +b.dataset.p;
      $$('#lc-pct button', body).forEach((x) => x.classList.toggle('active', x === b));
    };
    U.modal({
      title: 'Limit close – ' + s, width: 380, body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Confirm', cls: 'primary',
          onClick: () => {
            const r = Engine.closePosition(a.id, s, { pct, type: 'limit', price: parseFloat($('#lc-px', body).value) });
            if (!r.ok) { U.toast(r.error, 'err'); return false; }
            U.toast(r.filled ? 'Position closed' : 'Limit close order placed', 'ok');
          },
        },
      ],
    });
  }

  function wireBottom() {
    const bp = $('#bottom-panel');
    bp.addEventListener('click', (e) => {
      const tab = e.target.closest('.bt-tabs button[data-t]');
      if (tab) { bottomTab = tab.dataset.t; return renderBottom(); }
      const a = A();
      if (e.target.id === 'bt-closeall') return Engine.closeAll(a.id);
      if (e.target.id === 'bt-cancelall') return Engine.cancelAll(a.id);
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const tr = b.closest('tr');
      const s = tr && tr.dataset.sym;
      switch (b.dataset.act) {
        case 'goto': T.select(s); break;
        case 'goto2': T.select(b.dataset.sym); break;
        case 'tpsl': T.tpslDialog({ kind: 'pos', sym: s }); break;
        case 'otpsl': T.tpslDialog({ kind: 'order', id: tr.dataset.id }); break;
        case 'mkt': {
          const r = Engine.closePosition(a.id, s);
          if (!r.ok) U.toast(r.error, 'err');
          else U.toast(`Closed ${s} @ ${fmtP(r.px)}`, 'ok');
          break;
        }
        case 'lmt': limitCloseDialog(s); break;
        case 'cancel': Engine.cancelOrder(a.id, tr.dataset.id); break;
      }
    });
  }

  /* ------------------------------------------------------------------ live loop */
  function updateAll() {
    updateSymbar();
    updateLive();
    updateAcctPanel();
    updateOrderInfo();
    Accounts.updateChip();
  }
  T.updateAll = updateAll;

  let structSig = '';
  U.on('engine:change', () => {
    const a = A();
    const sig = a ? Object.keys(a.positions).map((k) => k + a.positions[k].size + a.positions[k].entry).join() + '|' + a.orders.map((o) => o.id + o.price + (o.sl || '') + o.tps.map((t) => t.price + ':' + t.pct).join('/')).join() + '|' + a.trades.length + a.orderHistory.length + a.tx.length + a.id : '';
    if (sig !== structSig) {
      structSig = sig;
      renderBottom();
    }
    updateAll();
  });
  U.on('engine:account', () => {
    structSig = '';
    renderOrderPanel();
    renderBottom();
    updateAll();
  });
  U.on('feed:ctx', updateSymbar);
  U.on('feed:mids', () => {
    // keep last price moving even if trade prints are sparse
    if (!lastPx) lastPx = Feed.mid(sym);
  });
  U.on('feed:candle', (c) => {
    if (M() && c.coin === M().coin && !recentTrades.length) {
      if (lastPx) lastDir = c.close > lastPx ? 1 : c.close < lastPx ? -1 : lastDir;
      lastPx = c.close;
    }
  });
  U.on('chart:loaded', () => {
    const c = ChartView.lastCandle();
    if (c && !recentTrades.length) lastPx = c.close;
    updateAll();
  });

  /* ------------------------------------------------------------------ init */
  T.init = () => {
    const prefs = Engine.prefs();
    if (prefs.symbol && Feed.bySym[prefs.symbol]) sym = prefs.symbol;
    else sym = Feed.bySym['BTCUSDT'] ? 'BTCUSDT' : Feed.markets[0].sym;
    if (prefs.interval && Feed.IV[prefs.interval]) interval = prefs.interval;
    lastPx = Feed.mid(sym);
    renderSymbar();
    renderChartToolbar();
    renderBookShell();
    renderOrderPanel();
    renderAcctPanel();
    renderBottom();
    wireBottom();
    ChartView.init();
    ChartView.load(sym, interval);
    new ResizeObserver(() => scheduleBook()).observe($('#book-panel'));
    setInterval(() => {
      if (!$('#view-trade').classList.contains('active')) return;
      updateSymbar();
      updateLive();
      updateAcctPanel();
      updateOrderInfo();
      Accounts.updateChip();
    }, 300);
    U.on('feed:mids', () => {});
  };
})();
