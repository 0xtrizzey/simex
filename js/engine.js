/* SimEx – paper trading engine
 * Accounts, orders, positions (one-way mode), cross / isolated margin, liquidation, TP/SL,
 * funding, fees (maker/taker), persistence in localStorage and offline catch-up.
 */
(function () {
  const E = (window.Engine = {});
  const KEY = 'simex.v1';
  const EPS = 1e-10;
  E.MIN_NOTIONAL = 10;
  E.replaying = false;
  E.last = {}; // sym -> { px, ts }

  let S = { v: 1, accounts: {}, order: [], active: null, lastTick: Date.now(), lastFundingHour: 0, prefs: {} };
  E.S = () => S;
  E.prefs = () => S.prefs;
  E.setPref = (k, v) => {
    S.prefs[k] = v;
    save();
  };

  /* ---------- persistence ---------- */
  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(E.saveNow, 400);
  }
  // Data is kept in localStorage AND (when served by server.js) in data/state.json on disk.
  E.serverOk = false;
  let pushing = false, pushAgain = false;
  async function pushServer() {
    if (!E.serverOk) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S) });
    } catch (e) { /* server stopped – localStorage copy still exists */ }
    pushing = false;
    if (pushAgain) { pushAgain = false; pushServer(); }
  }
  E.saveNow = () => {
    clearTimeout(saveT);
    S.savedAt = Date.now();
    U.store.set(KEY, S);
    pushServer();
  };
  function migrate() {
    S.order.forEach((id) => {
      const a = S.accounts[id];
      const conv = (h) => {
        if (!h.tps) h.tps = h.tp ? [{ id: Math.random().toString(36).slice(2, 8), price: h.tp, pct: 100 }] : [];
        delete h.tp;
      };
      for (const sym in a.positions) conv(a.positions[sym]);
      a.orders.forEach(conv);
    });
  }
  E.load = async () => {
    let d = U.store.get(KEY, null);
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.status === 200 || r.status === 204) {
        E.serverOk = true;
        if (r.status === 200) {
          const sd = await r.json();
          if (sd && sd.accounts && (!d || !d.accounts || (sd.savedAt || 0) >= (d.savedAt || 0))) d = sd;
        }
      }
    } catch (e) { /* opened as a plain file – localStorage only */ }
    if (d && d.accounts) {
      S = Object.assign(S, d);
      if (!S.order) S.order = Object.keys(S.accounts);
      if (!S.prefs) S.prefs = {};
    }
    if (!S.active || !S.accounts[S.active]) S.active = S.order[0] || null;
    migrate();
    if (E.serverOk) E.saveNow();
    return S;
  };
  E.exportJSON = () => JSON.stringify(S);
  E.importJSON = (text) => {
    const d = JSON.parse(text);
    if (!d || !d.accounts || !d.order) throw new Error('Not a SimEx backup file');
    S = Object.assign({ v: 1, prefs: {}, lastTick: Date.now(), lastFundingHour: 0 }, d);
    if (!S.accounts[S.active]) S.active = S.order[0] || null;
    migrate();
    E.saveNow();
    U.emit('engine:account');
    U.emit('engine:change');
  };

  /* ---------- accounts ---------- */
  const COLORS = ['#f7a600', '#3b8cf0', '#a66bff', '#2ebd85', '#f6465d', '#14c4c4', '#e056a0', '#9aa4b2'];
  E.presets = {
    Bybit: { maker: 0.02, taker: 0.055 },
    Hyperliquid: { maker: 0.015, taker: 0.045 },
    Binance: { maker: 0.02, taker: 0.05 },
    OKX: { maker: 0.02, taker: 0.05 },
    'Zero fees': { maker: 0, taker: 0 },
  };
  E.acct = (id) => S.accounts[id];
  E.active = () => S.accounts[S.active] || null;
  E.accounts = () => S.order.map((id) => S.accounts[id]);
  E.setActive = (id) => {
    if (!S.accounts[id]) return;
    S.active = id;
    save();
    U.emit('engine:account');
    U.emit('engine:change');
  };

  E.createAccount = ({ name, balance, maker, taker, funding = true, color }) => {
    const id = U.uid();
    const now = Date.now();
    const a = {
      id,
      name: name || 'Account ' + (S.order.length + 1),
      color: color || COLORS[S.order.length % COLORS.length],
      createdAt: now,
      startBalance: +balance,
      maker: +maker,
      taker: +taker,
      funding,
      balance: +balance,
      flow: 0,
      positions: {},
      orders: [],
      orderHistory: [],
      trades: [],
      fills: [],
      tx: [],
      curve: [[now, +balance]],
      lev: {},
      seq: 0,
    };
    S.accounts[id] = a;
    S.order.push(id);
    if (!S.active) S.active = id;
    save();
    U.emit('engine:change');
    return a;
  };
  E.updateAccount = (id, patch) => {
    const a = S.accounts[id];
    if (!a) return;
    Object.assign(a, patch);
    if (patch.startBalance != null && !a.fills.length) {
      a.balance = +patch.startBalance;
      a.curve = [[Date.now(), +patch.startBalance]];
    }
    save();
    U.emit('engine:change');
  };
  E.deleteAccount = (id) => {
    delete S.accounts[id];
    S.order = S.order.filter((x) => x !== id);
    if (S.active === id) S.active = S.order[0] || null;
    save();
    U.emit('engine:account');
    U.emit('engine:change');
  };
  E.resetAccount = (id) => {
    const a = S.accounts[id];
    if (!a) return;
    const now = Date.now();
    Object.assign(a, { balance: a.startBalance, flow: 0, positions: {}, orders: [], orderHistory: [], trades: [], fills: [], tx: [], curve: [[now, a.startBalance]], seq: 0 });
    save();
    U.emit('engine:change');
  };

  /* ---------- market helpers ---------- */
  E.price = (sym) => {
    const l = E.last[sym];
    if (E.replaying) return l ? l.px : 0;
    const m = Feed.bySym[sym];
    const ft = m ? Feed.midTs[m.coin] || 0 : 0;
    if (l && l.ts >= ft) return l.px;
    return Feed.mid(sym) || (l ? l.px : 0);
  };
  // Maintenance margin rate (Bybit-style tiers by position value) + taker fee to close the position.
  // Leverage up to 100x is allowed on every market (base tier 0.5% => liquidation ~0.5% before the 1% initial margin is used up at 100x).
  const MM_TIERS = [[1e6, 0.005], [5e6, 0.01], [10e6, 0.02], [20e6, 0.025], [50e6, 0.05], [Infinity, 0.1]];
  const mmrOf = (sym, notional, a, lev) => {
    let r = 0.1;
    for (const [cap, x] of MM_TIERS) if ((notional || 0) <= cap) { r = x; break; }
    if (lev) r = Math.min(r, 0.8 / lev);
    return r + (a ? a.taker : 0);
  };
  E.mmr = mmrOf;
  E.levSetting = (a, sym) => {
    const m = Feed.bySym[sym];
    const maxLev = m ? m.maxLev : 20;
    const s = a.lev[sym] || { lev: Math.min(10, maxLev), mode: 'cross' };
    let lev = Math.min(s.lev, maxLev);
    let mode = m && m.onlyIsolated ? 'isolated' : s.mode;
    const pos = a.positions[sym];
    if (pos) {
      lev = pos.lev;
      mode = pos.mode;
    }
    return { lev, mode };
  };

  /* ---------- account metrics ---------- */
  E.metrics = (a) => {
    const per = {};
    let uCross = 0, imCross = 0, mmCross = 0, iso = 0, uIso = 0, mmIso = 0, notional = 0;
    for (const sym in a.positions) {
      const p = a.positions[sym];
      const px = E.price(sym) || p.mark || p.entry;
      p.mark = px;
      const dir = p.side === 'long' ? 1 : -1;
      const u = dir * p.size * (px - p.entry);
      const mmr = mmrOf(sym, p.size * px, a, p.lev);
      const mm = mmr * p.size * px;
      notional += p.size * px;
      per[sym] = { px, u, mm, mmr, dir };
      if (p.mode === 'isolated') {
        iso += p.margin;
        uIso += u;
        mmIso += mm;
        per[sym].margin = p.margin;
      } else {
        uCross += u;
        imCross += (p.size * p.entry) / p.lev;
        mmCross += mm;
        per[sym].margin = (p.size * p.entry) / p.lev;
      }
      per[sym].roe = per[sym].margin ? (u / per[sym].margin) * 100 : 0;
    }
    const W = a.balance;
    const crossEq = W + uCross;
    let reserved = 0;
    a.orders.forEach((o) => {
      if (!o.reduceOnly) reserved += (o.size * o.price) / (o.lev || 10);
    });
    const avail = Math.max(0, crossEq - imCross - reserved);
    // liquidation prices
    for (const sym in per) {
      const p = a.positions[sym];
      const q = per[sym];
      const mmr = q.mmr;
      let liq;
      if (p.mode === 'isolated') {
        liq = q.dir > 0 ? (p.size * p.entry - p.margin) / (p.size * (1 - mmr)) : (p.margin + p.size * p.entry) / (p.size * (1 + mmr));
      } else {
        const otherU = uCross - q.u;
        const otherMM = mmCross - q.mm;
        liq =
          q.dir > 0
            ? (otherMM - W - otherU + p.size * p.entry) / (p.size * (1 - mmr))
            : (W + otherU - otherMM + p.size * p.entry) / (p.size * (1 + mmr));
      }
      q.liq = Number.isFinite(liq) && liq > 0 ? liq : null;
    }
    const equity = W + iso + uCross + uIso;
    return {
      per,
      equity,
      balance: W,
      uPnl: uCross + uIso,
      uCross,
      uIso,
      imCross,
      mmCross,
      mmIso,
      isoMargin: iso,
      crossEq,
      reserved,
      avail,
      notional,
      marginRatio: equity > 0 ? ((mmCross + mmIso) / equity) * 100 : 0,
      marginUsed: imCross + iso,
    };
  };

  E.estLiq = (a, sym, side, qty, price, lev, mode) => {
    const pos = a.positions[sym];
    const dir = side === 'buy' ? 1 : -1;
    let size = qty, entry = price;
    if (pos) {
      if ((pos.side === 'long' ? 1 : -1) !== dir) return null;
      size = pos.size + qty;
      entry = (pos.size * pos.entry + qty * price) / size;
      mode = pos.mode;
      lev = pos.lev;
    }
    const mmr = mmrOf(sym, size * price, a, lev);
    let liq;
    if (mode === 'isolated') {
      const margin = (size * entry) / lev;
      liq = dir > 0 ? (size * entry - margin) / (size * (1 - mmr)) : (margin + size * entry) / (size * (1 + mmr));
    } else {
      const m = E.metrics(a);
      const own = pos ? m.per[sym] : null;
      const otherU = m.uCross - (own ? own.u : 0);
      const otherMM = m.mmCross - (own ? own.mm : 0);
      const W = a.balance - size * price * a.taker;
      liq = dir > 0 ? (otherMM - W - otherU + size * entry) / (size * (1 - mmr)) : (W + otherU - otherMM + size * entry) / (size * (1 + mmr));
    }
    return Number.isFinite(liq) && liq > 0 ? liq : null;
  };

  /* ---------- bookkeeping ---------- */
  const nextId = (a) => String(++a.seq).padStart(5, '0');
  const pushCap = (arr, item, cap) => {
    arr.push(item);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  };

  function snap(a, ts, force) {
    const m = E.metrics(a);
    const v = m.equity - a.flow;
    const last = a.curve[a.curve.length - 1];
    if (last) {
      if (ts < last[0]) ts = last[0];
      if (!force && ts - last[0] < 10000) return;
      if (last[0] === ts) {
        last[1] = v;
        return;
      }
    }
    a.curve.push([ts, v]);
    if (a.curve.length > 8000) {
      const keep = a.curve.slice(-3000);
      const old = a.curve.slice(0, -3000).filter((_, i) => i % 2 === 0);
      a.curve = old.concat(keep);
    }
  }
  E.snap = (a, force) => snap(a, Date.now(), force);
  // periodic equity sampling for accounts that hold positions
  let catching = false;
  E.runCatchUp = () => {
    if (catching) return Promise.resolve(null);
    catching = true;
    return E.catchUp()
      .then((r) => {
        if (r) U.emit('engine:caughtup', r);
        return r;
      })
      .catch((e) => console.warn('catch-up failed', e))
      .finally(() => (catching = false));
  };
  E.sample = () => {
    const now = Date.now();
    if (now - S.lastTick > 90e3) {
      // the page was asleep / offline for a while: replay what happened to open positions & orders
      if (Feed.connected && Feed.markets.length) E.runCatchUp();
      return;
    }
    S.order.forEach((id) => {
      const a = S.accounts[id];
      if (Object.keys(a.positions).length) snap(a, now, false);
    });
    S.lastTick = now;
    save();
  };

  function logOrder(a, o, status, extra) {
    Object.assign(o, extra || {}, { status, doneAt: extra && extra.doneAt ? extra.doneAt : Date.now() });
    pushCap(a.orderHistory, o, 1000);
  }

  /* ---------- fills ---------- */
  function newPos(a, sym, dir, ts, st) {
    return {
      sym,
      side: dir > 0 ? 'long' : 'short',
      size: 0,
      entry: 0,
      lev: st.lev,
      mode: st.mode,
      margin: 0,
      tps: [],
      tpDone: 0,
      sl: null,
      risk0: null,
      openedAt: ts,
      entryQty: 0,
      entryVal: 0,
      exitQty: 0,
      exitVal: 0,
      maxSize: 0,
      realized: 0,
      fees: 0,
      funding: 0,
      hi: 0,
      lo: Infinity,
      mark: 0,
    };
  }

  // Core accounting. Returns { fee, pnl }
  function executeFill(a, sym, side, size, px, liq, ts, o) {
    o = o || {};
    const feeRate = liq === 'maker' ? a.maker : a.taker;
    const dir = side === 'buy' ? 1 : -1;
    let remaining = size;
    let totFee = 0, totPnl = 0;
    let pos = a.positions[sym];

    if (pos && (pos.side === 'long' ? 1 : -1) !== dir) {
      const cq = Math.min(remaining, pos.size);
      const pdir = pos.side === 'long' ? 1 : -1;
      const pnl = pdir * cq * (px - pos.entry);
      const fee = cq * px * feeRate;
      const marginRel = pos.mode === 'isolated' ? pos.margin * (cq / pos.size) : 0;
      let returned = pnl - fee + marginRel;
      a.balance += returned;
      if (pos.mode === 'isolated') pos.margin -= marginRel;
      let pen = 0;
      if (o.liq) {
        pen = o.liqPenalty != null ? o.liqPenalty : Math.max(0, returned);
        pen = Math.min(pen, Math.max(0, a.balance));
        a.balance -= pen;
      }
      pos.realized += pnl;
      pos.fees += fee + pen;
      pos.exitQty += cq;
      pos.exitVal += cq * px;
      pos.size -= cq;
      remaining -= cq;
      totFee += fee + pen;
      totPnl += pnl;
      pushCap(a.fills, { id: nextId(a), t: ts, sym, side, px, size: cq, fee: fee + pen, liq, reason: o.reason || 'manual', pnl, orderId: o.orderId || null, kind: 'close' }, 3000);
      if (pos.size <= EPS) {
        closeTrade(a, pos, ts, o.reason || 'manual');
        delete a.positions[sym];
        // drop reduce-only orders of a closed position
        a.orders.filter((x) => x.sym === sym && x.reduceOnly).forEach((x) => cancelInternal(a, x, 'Position closed'));
        pos = null;
      }
      if (a.balance < 0) a.balance = 0;
    }

    if (remaining > EPS && !o.reduceOnly) {
      const st = E.levSetting(a, sym);
      const fee = remaining * px * feeRate;
      if (!pos) {
        pos = newPos(a, sym, dir, ts, st);
        a.positions[sym] = pos;
        pos.entry = px;
      }
      const newSize = pos.size + remaining;
      pos.entry = (pos.size * pos.entry + remaining * px) / newSize;
      pos.size = newSize;
      pos.maxSize = Math.max(pos.maxSize, newSize);
      pos.entryQty += remaining;
      pos.entryVal += remaining * px;
      const im = (remaining * px) / pos.lev;
      if (pos.mode === 'isolated') {
        pos.margin += im;
        a.balance -= im;
      }
      a.balance -= fee;
      pos.fees += fee;
      pos.hi = Math.max(pos.hi, px);
      pos.lo = Math.min(pos.lo, px);
      totFee += fee;
      if (o.tps && o.tps.length) pos.tps = o.tps.map((t) => ({ id: t.id || tpId(), price: t.price, pct: t.pct }));
      if (o.sl) pos.sl = o.sl;
      if (pos.sl && pos.risk0 == null) pos.risk0 = pos.size * Math.abs(pos.entry - pos.sl);
      pushCap(a.fills, { id: nextId(a), t: ts, sym, side, px, size: remaining, fee, liq, reason: o.reason || 'manual', pnl: 0, orderId: o.orderId || null, kind: 'open' }, 3000);
    }
    return { fee: totFee, pnl: totPnl };
  }

  function closeTrade(a, pos, ts, reason) {
    const entry = pos.entryVal / pos.entryQty;
    const exit = pos.exitVal / pos.exitQty;
    const pnl = pos.realized - pos.fees + pos.funding;
    const long = pos.side === 'long';
    const hi = Math.max(pos.hi, entry, exit), lo = Math.min(pos.lo === Infinity ? entry : pos.lo, entry, exit);
    const mfe = long ? (hi - entry) / entry : (entry - lo) / entry;
    const mae = long ? (entry - lo) / entry : (hi - entry) / entry;
    const margin = pos.entryVal / pos.lev;
    pushCap(
      a.trades,
      {
        id: nextId(a),
        sym: pos.sym,
        side: pos.side,
        entry,
        exit,
        size: pos.maxSize,
        notional: pos.entryVal,
        lev: pos.lev,
        mode: pos.mode,
        openTime: pos.openedAt,
        closeTime: ts,
        gross: pos.realized,
        fees: pos.fees,
        funding: pos.funding,
        pnl,
        roe: margin ? (pnl / margin) * 100 : 0,
        mfe: mfe * 100,
        mae: mae * 100,
        risk: pos.risk0 || null,
        r: pos.risk0 ? pnl / pos.risk0 : null,
        reason,
      },
      20000
    );
  }

  /* ---------- order handling ---------- */
  function cancelInternal(a, o, reason) {
    const i = a.orders.indexOf(o);
    if (i >= 0) a.orders.splice(i, 1);
    logOrder(a, o, 'cancelled', { reason });
  }

  function checkMargin(a, sym, side, size, price, lev) {
    const pos = a.positions[sym];
    const dir = side === 'buy' ? 1 : -1;
    let openQty = size;
    if (pos && (pos.side === 'long' ? 1 : -1) !== dir) openQty = Math.max(0, size - pos.size);
    if (openQty <= EPS) return null;
    const m = E.metrics(a);
    const need = (openQty * price) / lev + size * price * a.taker;
    if (need > m.avail + 1e-9) return `Insufficient margin – need ${U.fmt(need)} USDT, available ${U.fmt(m.avail)} USDT`;
    return null;
  }

  E.validTpSl = (side, mark, tp, sl) => {
    // side: 'long' | 'short'
    if (tp != null && ((side === 'long' && tp <= mark) || (side === 'short' && tp >= mark)))
      return `Take-profit must be ${side === 'long' ? 'above' : 'below'} the current price`;
    if (sl != null && ((side === 'long' && sl >= mark) || (side === 'short' && sl <= mark)))
      return `Stop-loss must be ${side === 'long' ? 'below' : 'above'} the current price`;
    return null;
  };

  /* ---------- take-profit ladder (partial TPs) + stop-loss ---------- */
  const tpId = () => Math.random().toString(36).slice(2, 8);
  const normTps = (list) => (list || []).map((t) => ({ id: t.id || tpId(), price: +t.price, pct: +t.pct })).filter((t) => t.price > 0);
  E.normTps = normTps;
  // side: 'long' | 'short'; ref: price the levels are compared to (mark for positions, limit price for orders)
  function validateTpsl(side, ref, tps, sl) {
    if (tps) {
      if (tps.length > 5) return 'Maximum 5 take-profit levels';
      let sum = 0;
      for (const t of tps) {
        if (!(t.pct > 0 && t.pct <= 100)) return 'Each take-profit size must be between 0 and 100 %';
        sum += t.pct;
        if ((side === 'long' && t.price <= ref) || (side === 'short' && t.price >= ref)) return `Take-profit must be ${side === 'long' ? 'above' : 'below'} the ${E.refName || 'current'} price`;
      }
      if (sum > 100.0001) return `Total take-profit size is ${sum.toFixed(0)}% - it cannot exceed 100%`;
    }
    if (sl != null && ((side === 'long' && sl >= ref) || (side === 'short' && sl <= ref))) return `Stop-loss must be ${side === 'long' ? 'below' : 'above'} the ${E.refName || 'current'} price`;
    return null;
  }
  E.validateTpsl = validateTpsl;
  // ref: { kind:'pos', sym } | { kind:'order', id }
  function ctxOf(a, ref) {
    if (!a || !ref) return null;
    if (ref.kind === 'pos') {
      const p = a.positions[ref.sym];
      return p ? { h: p, side: p.side, refPx: E.price(ref.sym), pos: p } : null;
    }
    const o = a.orders.find((x) => x.id === ref.id);
    return o && !o.reduceOnly ? { h: o, side: o.side === 'buy' ? 'long' : 'short', refPx: o.price, order: o } : null;
  }
  E.tpslSet = (accId, ref, patch) => {
    const a = S.accounts[accId];
    const c = ctxOf(a, ref);
    if (!c) return { ok: false, error: ref && ref.kind === 'order' ? 'Order not found (reduce-only orders cannot have TP/SL)' : 'No open position' };
    const tps = patch.tps !== undefined ? normTps(patch.tps) : undefined;
    E.refName = c.order ? 'order' : 'current';
    const err = validateTpsl(c.side, c.refPx, tps, patch.sl === undefined ? null : patch.sl);
    E.refName = null;
    if (err) return { ok: false, error: err };
    if (tps !== undefined) c.h.tps = tps;
    if (patch.sl !== undefined) {
      c.h.sl = patch.sl;
      if (c.pos && patch.sl != null && c.pos.risk0 == null) c.pos.risk0 = c.pos.size * Math.abs(c.pos.entry - patch.sl);
    }
    afterChange(a);
    return { ok: true };
  };
  E.tpAdd = (accId, ref, price, pct) => {
    const a = S.accounts[accId];
    const c = ctxOf(a, ref);
    if (!c) return { ok: false, error: 'Position or order not found' };
    const list = c.h.tps.map((t) => Object.assign({}, t));
    const sum = list.reduce((x, t) => x + t.pct, 0);
    if (pct == null) {
      if (sum < 99.99) pct = Math.round((100 - sum) * 100) / 100;
      else if (list.length) {
        const big = list.reduce((m, t) => (t.pct > m.pct ? t : m));
        const half = Math.floor(big.pct / 2);
        if (half < 1) return { ok: false, error: 'No size left for another take-profit' };
        big.pct -= half;
        pct = half;
      } else pct = 100;
    }
    list.push({ price, pct });
    return E.tpslSet(accId, ref, { tps: list });
  };
  E.tpUpdate = (accId, ref, id, patch) => {
    const c = ctxOf(S.accounts[accId], ref);
    if (!c) return { ok: false, error: 'Position or order not found' };
    return E.tpslSet(accId, ref, { tps: c.h.tps.map((t) => (t.id === id ? Object.assign({}, t, patch) : t)) });
  };
  E.tpRemove = (accId, ref, id) => {
    const c = ctxOf(S.accounts[accId], ref);
    if (!c) return { ok: false, error: 'Position or order not found' };
    return E.tpslSet(accId, ref, { tps: c.h.tps.filter((t) => t.id !== id) });
  };
  E.slSet = (accId, ref, price) => E.tpslSet(accId, ref, { sl: price });

  /**
   * o: { sym, side:'buy'|'sell', type:'market'|'limit'|'stop', size (base units), price?, reduceOnly?, tps?:[{price,pct}], sl? }
   */
  E.placeOrder = (accId, o) => {
    const a = S.accounts[accId];
    if (!a) return { ok: false, error: 'No account selected' };
    const m = Feed.bySym[o.sym];
    if (!m) return { ok: false, error: 'Unknown market' };
    if (!Feed.fresh(o.sym)) return { ok: false, error: 'No live price for ' + o.sym + ' – check your connection' };
    const mark = E.price(o.sym);
    let size = U.floorTo(+o.size, m.szDec);
    if (!(size > 0)) return { ok: false, error: 'Enter a valid size' };
    const dir = o.side === 'buy' ? 1 : -1;
    const pos = a.positions[o.sym];
    const st = E.levSetting(a, o.sym);

    if (o.reduceOnly) {
      if (!pos || (pos.side === 'long' ? 1 : -1) === dir) return { ok: false, error: 'Reduce-only: no position to reduce' };
      size = Math.min(size, pos.size);
    }
    const refPx = o.type === 'market' ? mark : +o.price;
    if (!(refPx > 0)) return { ok: false, error: 'Enter a valid price' };
    if (!o.reduceOnly && size * refPx < E.MIN_NOTIONAL) return { ok: false, error: `Order value must be at least ${E.MIN_NOTIONAL} USDT` };

    // TP/SL sanity (relative to entry price of the order)
    const tps = o.reduceOnly ? [] : normTps(o.tps || (o.tp ? [{ price: o.tp, pct: 100 }] : []));
    if (!o.reduceOnly && (tps.length || o.sl)) {
      const err = validateTpsl(dir > 0 ? 'long' : 'short', refPx, tps, o.sl || null);
      if (err) return { ok: false, error: err };
    }

    const base = { id: nextId(a), sym: o.sym, side: o.side, type: o.type, size, price: o.price ? +o.price : null, reduceOnly: !!o.reduceOnly, tps, sl: o.sl || null, lev: st.lev, mode: st.mode, createdAt: Date.now() };

    if (o.type === 'market') {
      if (!o.reduceOnly) {
        const err = checkMargin(a, o.sym, o.side, size, mark, st.lev);
        if (err) return { ok: false, error: err };
      }
      const px = Feed.fillPrice(o.sym, o.side, size);
      const r = executeFill(a, o.sym, o.side, size, px, 'taker', Date.now(), { reason: 'market', orderId: base.id, tps: base.tps, sl: base.sl, reduceOnly: o.reduceOnly });
      logOrder(a, base, 'filled', { avgPx: px, fee: r.fee });
      afterChange(a);
      return { ok: true, order: base, filled: true, px, fee: r.fee };
    }

    if (o.type === 'limit') {
      const ba = Feed.bestBidAsk(o.sym);
      const marketable = o.side === 'buy' ? base.price >= ba.ask : base.price <= ba.bid;
      if (marketable) {
        if (!o.reduceOnly) {
          const err = checkMargin(a, o.sym, o.side, size, base.price, st.lev);
          if (err) return { ok: false, error: err };
        }
        let px = Feed.fillPrice(o.sym, o.side, size);
        px = o.side === 'buy' ? Math.min(px, base.price) : Math.max(px, base.price);
        const r = executeFill(a, o.sym, o.side, size, px, 'taker', Date.now(), { reason: 'limit', orderId: base.id, tps: base.tps, sl: base.sl, reduceOnly: o.reduceOnly });
        logOrder(a, base, 'filled', { avgPx: px, fee: r.fee });
        afterChange(a);
        return { ok: true, order: base, filled: true, px, fee: r.fee };
      }
    }

    if (o.type === 'stop') {
      if ((o.side === 'buy' && base.price <= mark) || (o.side === 'sell' && base.price >= mark))
        return { ok: false, error: `Stop trigger must be ${o.side === 'buy' ? 'above' : 'below'} the current price` };
    }

    if (!o.reduceOnly) {
      const err = checkMargin(a, o.sym, o.side, size, base.price, st.lev);
      if (err) return { ok: false, error: err };
    }
    a.orders.push(base);
    afterChange(a);
    return { ok: true, order: base, filled: false };
  };

  E.cancelOrder = (accId, id, reason) => {
    const a = S.accounts[accId];
    const o = a && a.orders.find((x) => x.id === id);
    if (!o) return;
    cancelInternal(a, o, reason || 'Cancelled by user');
    afterChange(a);
  };
  E.cancelAll = (accId, sym) => {
    const a = S.accounts[accId];
    if (!a) return;
    a.orders.slice().forEach((o) => (!sym || o.sym === sym) && cancelInternal(a, o, 'Cancelled by user'));
    afterChange(a);
  };

  E.modifyOrder = (accId, id, price) => {
    const a = S.accounts[accId];
    const o = a && a.orders.find((x) => x.id === id);
    if (!o) return { ok: false, error: 'Order not found' };
    const mark = E.price(o.sym);
    if (o.type === 'stop' && ((o.side === 'buy' && price <= mark) || (o.side === 'sell' && price >= mark)))
      return { ok: false, error: `Stop trigger must be ${o.side === 'buy' ? 'above' : 'below'} the current price` };
    if (o.type === 'limit') {
      const ba = Feed.bestBidAsk(o.sym);
      if ((o.side === 'buy' && price >= ba.ask) || (o.side === 'sell' && price <= ba.bid))
        return { ok: false, error: `Limit ${o.side} would fill immediately – use a market order instead` };
    }
    if (!o.reduceOnly && ((o.tps && o.tps.length) || o.sl)) {
      E.refName = 'new order';
      const err = validateTpsl(o.side === 'buy' ? 'long' : 'short', price, o.tps, o.sl);
      E.refName = null;
      if (err) return { ok: false, error: 'Move its TP/SL first - ' + err };
    }
    o.price = price;
    afterChange(a);
    return { ok: true };
  };

  E.closePosition = (accId, sym, { qty, pct, type = 'market', price } = {}) => {
    const a = S.accounts[accId];
    const pos = a && a.positions[sym];
    if (!pos) return { ok: false, error: 'No open position' };
    const m = Feed.bySym[sym];
    let size = qty != null ? qty : pos.size * ((pct == null ? 100 : pct) / 100);
    size = pct == null || pct >= 100 ? pos.size : U.floorTo(size, m.szDec);
    if (!(size > 0)) return { ok: false, error: 'Quantity too small' };
    return E.placeOrder(accId, { sym, side: pos.side === 'long' ? 'sell' : 'buy', type: type === 'limit' ? 'limit' : 'market', size: Math.min(size, pos.size), price, reduceOnly: true });
  };
  E.closeAll = (accId) => {
    const a = S.accounts[accId];
    if (!a) return;
    Object.keys(a.positions).forEach((sym) => E.closePosition(accId, sym));
  };

  E.setLeverage = (accId, sym, lev, mode) => {
    const a = S.accounts[accId];
    const m = Feed.bySym[sym];
    if (!a || !m) return { ok: false, error: 'Unknown market' };
    lev = U.clamp(Math.round(lev), 1, m.maxLev);
    const pos = a.positions[sym];
    if (m.onlyIsolated) mode = 'isolated';
    if (pos) {
      if (mode && mode !== pos.mode) return { ok: false, error: 'Close the position before changing the margin mode' };
      if (pos.mode === 'isolated') {
        const target = (pos.size * pos.entry) / lev;
        const diff = target - pos.margin;
        const mt = E.metrics(a);
        if (diff > mt.avail + 1e-9) return { ok: false, error: 'Insufficient margin to lower leverage' };
        const px = E.price(sym);
        const dir = pos.side === 'long' ? 1 : -1;
        const tmp = Object.assign({}, pos, { margin: target });
        const mm0 = mmrOf(sym, pos.size * px, a, lev);
        const liq = dir > 0 ? (tmp.size * tmp.entry - tmp.margin) / (tmp.size * (1 - mm0)) : (tmp.margin + tmp.size * tmp.entry) / (tmp.size * (1 + mm0));
        if ((dir > 0 && px <= liq) || (dir < 0 && px >= liq)) return { ok: false, error: 'Leverage too high – position would be liquidated immediately' };
        a.balance -= diff;
        pos.margin = target;
      } else {
        const mt = E.metrics(a);
        const extra = (pos.size * pos.entry) / lev - (pos.size * pos.entry) / pos.lev;
        if (extra > mt.avail + 1e-9) return { ok: false, error: 'Insufficient margin to lower leverage' };
      }
      pos.lev = lev;
    }
    a.lev[sym] = { lev, mode: mode || (a.lev[sym] ? a.lev[sym].mode : 'cross') };
    save();
    U.emit('engine:change');
    return { ok: true };
  };

  E.deposit = (accId, amount, note) => {
    const a = S.accounts[accId];
    if (!a || !(amount > 0)) return { ok: false, error: 'Invalid amount' };
    a.balance += amount;
    a.flow += amount;
    pushCap(a.tx, { t: Date.now(), type: 'deposit', amount, note: note || 'Deposit' }, 3000);
    snap(a, Date.now(), true);
    afterChange(a);
    return { ok: true };
  };
  E.withdraw = (accId, amount, note) => {
    const a = S.accounts[accId];
    if (!a || !(amount > 0)) return { ok: false, error: 'Invalid amount' };
    const m = E.metrics(a);
    if (amount > Math.min(m.avail, a.balance) + 1e-9) return { ok: false, error: 'Amount exceeds available balance' };
    a.balance -= amount;
    a.flow -= amount;
    pushCap(a.tx, { t: Date.now(), type: 'withdraw', amount: -amount, note: note || 'Withdrawal' }, 3000);
    snap(a, Date.now(), true);
    afterChange(a);
    return { ok: true };
  };

  function afterChange(a) {
    snap(a, Date.now(), true);
    save();
    U.emit('engine:change');
  }

  /* ---------- price processing (matching engine) ---------- */
  E.watched = () => {
    const set = new Set();
    S.order.forEach((id) => {
      const a = S.accounts[id];
      for (const s in a.positions) set.add(s);
      a.orders.forEach((o) => set.add(o.sym));
    });
    return set;
  };

  E.onPrice = (sym, px, ts, opt) => {
    if (!(px > 0)) return;
    ts = ts || Date.now();
    opt = opt || {};
    E.last[sym] = { px, ts };
    let any = false;
    for (const id of S.order) {
      const a = S.accounts[id];
      if (!a.positions[sym] && !a.orders.some((o) => o.sym === sym)) continue;
      if (processAccount(a, sym, px, ts, opt)) any = true;
    }
    if (any) {
      save();
      U.emit('engine:change');
    }
  };

  function closeAt(a, pos, px, liq, ts, reason, o) {
    return executeFill(a, pos.sym, pos.side === 'long' ? 'sell' : 'buy', pos.size, px, liq, ts, Object.assign({ reason, reduceOnly: true }, o || {}));
  }

  function notifyClose(a, sym, reason, pnlHint) {
    if (E.replaying) return;
    const t = a.trades[a.trades.length - 1];
    if (!t || t.sym !== sym) return;
    const label = { tp: 'Take profit', sl: 'Stop loss', liq: 'LIQUIDATED' }[reason] || 'Closed';
    U.toast(`${a.name}: ${label} – ${sym} ${t.side} <b class="${U.cls(t.pnl)}">${U.fmtS(t.pnl)} USDT</b>`, reason === 'liq' ? 'err' : t.pnl >= 0 ? 'ok' : 'info', 6000);
  }

  function processAccount(a, sym, px, ts, opt) {
    let changed = false;
    const gap = opt.gap !== false;
    const live = opt.src !== 'replay';

    // 1) resting orders
    for (const o of a.orders.slice()) {
      if (o.sym !== sym) continue;
      let fire = false, fillPx = px, liq = 'taker';
      if (o.type === 'limit') {
        if (o.side === 'buy' ? px <= o.price : px >= o.price) {
          fire = true;
          fillPx = o.price;
          liq = 'maker';
        }
      } else if (o.side === 'buy' ? px >= o.price : px <= o.price) {
        fire = true;
        fillPx = gap ? (o.side === 'buy' ? Math.max(px, o.price) : Math.min(px, o.price)) : o.price;
        if (live) {
          const w = Feed.fillPrice(sym, o.side, o.size);
          fillPx = o.side === 'buy' ? Math.max(fillPx, w) : Math.min(fillPx, w);
        }
      }
      if (fire) {
        fillPending(a, o, fillPx, liq, ts);
        changed = true;
      }
    }

    // 2) TP / SL
    let pos = a.positions[sym];
    if (pos) {
      pos.hi = Math.max(pos.hi, px);
      pos.lo = Math.min(pos.lo, px);
      const long = pos.side === 'long';
      if (pos.sl && (long ? px <= pos.sl : px >= pos.sl)) {
        let f = gap ? (long ? Math.min(px, pos.sl) : Math.max(px, pos.sl)) : pos.sl;
        if (live) {
          const w = Feed.fillPrice(sym, long ? 'sell' : 'buy', pos.size);
          f = long ? Math.min(f, w) : Math.max(f, w);
        }
        closeAt(a, pos, f, 'taker', ts, 'sl');
        notifyClose(a, sym, 'sl');
        changed = true;
      } else if (pos.tps.length) {
        const m = Feed.bySym[sym];
        const hits = pos.tps.filter((t) => (long ? px >= t.price : px <= t.price)).sort((x, y) => (long ? x.price - y.price : y.price - x.price));
        for (const t of hits) {
          pos = a.positions[sym];
          if (!pos) break;
          let qty = U.floorTo((pos.maxSize * t.pct) / 100, m.szDec);
          // a ladder that adds up to 100% (or leaves only dust) closes the whole position
          if (qty >= pos.size - 1e-9 || (pos.size - qty) * t.price < 5 || (pos.tpDone || 0) + t.pct >= 99.99) qty = pos.size;
          pos.tpDone = (pos.tpDone || 0) + t.pct;
          pos.tps = pos.tps.filter((x) => x.id !== t.id);
          if (!(qty > 0)) continue;
          executeFill(a, sym, long ? 'sell' : 'buy', qty, t.price, 'maker', ts, { reason: 'tp', reduceOnly: true });
          changed = true;
          if (!a.positions[sym]) notifyClose(a, sym, 'tp');
          else if (!E.replaying) U.toast(`${a.name}: <b class="up">Partial take-profit</b> - closed ${U.fmtQty(qty, m.szDec)} ${sym} @ ${U.fmt(t.price, U.pxDec(t.price, m.szDec))} (${t.pct}%)`, 'ok', 6000);
        }
      }
    }

    // 3) liquidation
    pos = a.positions[sym];
    if (pos) {
      const m = E.metrics(a);
      const q = m.per[sym];
      if (pos.mode === 'isolated') {
        if (q.liq && (pos.side === 'long' ? px <= q.liq : px >= q.liq)) {
          closeAt(a, pos, q.liq, 'taker', ts, 'liq', { liq: true });
          notifyClose(a, sym, 'liq');
          changed = true;
        }
      } else if (m.mmCross > 0 && m.crossEq <= m.mmCross) {
        Object.keys(a.positions).forEach((s) => {
          const p = a.positions[s];
          if (!p || p.mode !== 'cross') return;
          const pp = E.price(s) || p.entry;
          closeAt(a, p, pp, 'taker', ts, 'liq', { liq: true, liqPenalty: mmrOf(s, p.size * pp, a, p.lev) * p.size * pp });
          notifyClose(a, s, 'liq');
        });
        changed = true;
      }
    }

    if (changed) snap(a, ts, true);
    return changed;
  }

  function fillPending(a, o, px, liq, ts) {
    const pos = a.positions[o.sym];
    const dir = o.side === 'buy' ? 1 : -1;
    let size = o.size;
    // take the order out first so its own reservation doesn't block the margin check
    const i = a.orders.indexOf(o);
    if (i >= 0) a.orders.splice(i, 1);
    if (o.reduceOnly) {
      if (!pos || (pos.side === 'long' ? 1 : -1) === dir) return logOrder(a, o, 'cancelled', { reason: 'No position to reduce', doneAt: ts });
      size = Math.min(size, pos.size);
    } else {
      const err = checkMargin(a, o.sym, o.side, size, px, o.lev);
      if (err) {
        if (!E.replaying) U.toast(`${a.name}: ${o.sym} order rejected – ${err}`, 'err', 6000);
        return logOrder(a, o, 'rejected', { reason: err, doneAt: ts });
      }
    }
    const r = executeFill(a, o.sym, o.side, size, px, liq, ts, { reason: o.type, orderId: o.id, tps: o.tps, sl: o.sl, reduceOnly: o.reduceOnly });
    logOrder(a, o, 'filled', { avgPx: px, fee: r.fee, doneAt: ts, size });
    if (!E.replaying) {
      const p = a.positions[o.sym];
      U.toast(`${a.name}: ${o.type === 'limit' ? 'Limit' : 'Stop'} ${o.side} filled – ${U.fmtQty(size, Feed.bySym[o.sym].szDec)} ${o.sym} @ ${U.fmt(px, U.pxDec(px, Feed.bySym[o.sym].szDec))}`, 'ok');
    }
  }

  /* ---------- funding (hourly, Hyperliquid) ---------- */
  E.fundingTick = () => {
    const hour = Math.floor(Date.now() / 3600e3);
    if (!S.lastFundingHour) {
      S.lastFundingHour = hour;
      return;
    }
    if (hour <= S.lastFundingHour) return;
    S.lastFundingHour = hour;
    const ts = hour * 3600e3;
    S.order.forEach((id) => {
      const a = S.accounts[id];
      if (!a.funding) return;
      for (const sym in a.positions) {
        const c = Feed.ctx[sym];
        if (!c) continue;
        applyFunding(a, a.positions[sym], c.funding, ts);
      }
      snap(a, ts, true);
    });
    save();
    U.emit('engine:change');
  };
  function applyFunding(a, pos, rate, ts) {
    const px = E.price(pos.sym) || pos.entry;
    const dir = pos.side === 'long' ? 1 : -1;
    const pay = -dir * pos.size * px * rate;
    if (!Number.isFinite(pay) || pay === 0) return;
    a.balance += pay;
    pos.funding += pay;
    pushCap(a.tx, { t: ts, type: 'funding', amount: pay, note: `${pos.sym} ${pos.side} @ ${(rate * 100).toFixed(4)}%/h` }, 3000);
  }

  /* ---------- offline catch-up ---------- */
  E.catchUp = async () => {
    const now = Date.now();
    const gap = now - S.lastTick;
    const syms = new Set();
    S.order.forEach((id) => {
      const a = S.accounts[id];
      for (const s in a.positions) syms.add(s);
      a.orders.forEach((o) => syms.add(o.sym));
    });
    if (!syms.size || gap < 90e3) {
      S.lastTick = now;
      return null;
    }
    const iv = gap <= 5000 * 60e3 ? '1m' : gap <= 5000 * 300e3 ? '5m' : gap <= 5000 * 900e3 ? '15m' : '1h';
    const ivMs = Feed.IV[iv];
    const events = [];
    await Promise.all(
      [...syms].map(async (sym) => {
        const m = Feed.bySym[sym];
        if (!m) return;
        try {
          const cs = await Feed.candles(m.coin, iv, S.lastTick - ivMs, now);
          cs.forEach((c) => {
            const t0 = c.time * 1000;
            const bull = c.close >= c.open;
            const path = bull ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
            path.forEach((p, i) => events.push({ sym, px: p, ts: Math.max(S.lastTick, t0 + Math.round((i / 3) * (ivMs - 1))), open: i === 0 }));
          });
        } catch (e) {
          console.warn('catch-up failed for', sym, e);
        }
      })
    );
    events.sort((x, y) => x.ts - y.ts);
    const tradesBefore = S.order.reduce((n, id) => n + S.accounts[id].trades.length, 0);
    E.replaying = true;
    try {
      events.forEach((ev) => E.onPrice(ev.sym, ev.px, ev.ts, { src: 'replay', gap: ev.open }));
    } finally {
      E.replaying = false;
    }
    // funding while offline
    const fundOn = S.order.filter((id) => S.accounts[id].funding && Object.keys(S.accounts[id].positions).length);
    if (fundOn.length) {
      await Promise.all(
        [...syms].map(async (sym) => {
          const m = Feed.bySym[sym];
          try {
            const hist = await Feed.fundingHistory(m.coin, S.lastTick);
            hist.forEach((h) =>
              fundOn.forEach((id) => {
                const a = S.accounts[id];
                const pos = a.positions[sym];
                if (pos && h.time > Math.max(S.lastTick, pos.openedAt)) applyFunding(a, pos, +h.fundingRate, h.time);
              })
            );
          } catch (e) { /* ignore */ }
        })
      );
    }
    S.lastFundingHour = Math.floor(now / 3600e3);
    S.lastTick = now;
    S.order.forEach((id) => snap(S.accounts[id], now, true));
    const tradesAfter = S.order.reduce((n, id) => n + S.accounts[id].trades.length, 0);
    E.saveNow();
    U.emit('engine:change');
    return { gap, interval: iv, candles: events.length / 4, closed: tradesAfter - tradesBefore };
  };

  /* ---------- helper for the UI ---------- */
  E.openOrdersFor = (a, sym) => a.orders.filter((o) => o.sym === sym);
})();
