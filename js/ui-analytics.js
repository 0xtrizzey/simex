/* SimEx – Analytics page (quant stats, equity / drawdown curves) and P&L calendar */
(function () {
  const $ = U.$, $$ = U.$$;
  const LW = window.LightweightCharts;
  const GREEN = '#2ebd85', RED = '#f6465d';

  const fx = (n, d = 2) => (n === Infinity ? '∞' : Number.isFinite(n) ? U.fmt(n, d) : '–');
  const fxs = (n, d = 2) => (n === Infinity ? '∞' : Number.isFinite(n) ? U.fmtS(n, d) : '–');
  const pc = (n, d = 2) => (Number.isFinite(n) ? U.fmtPct(n, d) : '–');
  const pcp = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '–');
  const dur = (ms) => (Number.isFinite(ms) ? U.fmtDur(ms) : '–');
  const noAcct = '<div class="empty big"><span>Create an account to see your statistics.</span></div>';

  /* ================================================================ ANALYTICS */
  const An = (window.Analytics = { range: 'all', chart: null });
  const RANGES = [['24h', '24H', 86400e3], ['7d', '7D', 7 * 86400e3], ['30d', '30D', 30 * 86400e3], ['90d', '90D', 90 * 86400e3], ['all', 'All', 0]];
  let eqS, ddS, pnlS, shellFor = null, lastRender = 0;

  const row = (l, v, cls = '', tip = '') => `<div class="st-row" ${tip ? `title="${U.esc(tip)}"` : ''}><span>${l}</span><b class="${cls}">${v}</b></div>`;

  function shell() {
    $('#view-analytics').innerHTML = `<div class="an-wrap">
      <div class="an-head"><div><h2>Performance analytics</h2><div class="sub" id="an-acct"></div></div>
        <div class="seg" id="an-range">${RANGES.map(([k, l]) => `<button data-r="${k}" class="${k === An.range ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      <div id="an-body"></div></div>`;
    $('#an-range').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      An.range = b.dataset.r;
      $$('#an-range button').forEach((x) => x.classList.toggle('active', x === b));
      An.render(true);
    };
  }

  function barSvg(data, { fmt = (v) => U.fmtCompact(v), h = 170, rel = false } = {}) {
    if (!data.length) return '<div class="empty-note">No data</div>';
    const W = 420, padB = 22, padT = 14, ph = h - padB - padT;
    const max = Math.max(...data.map((d) => d.v), 0), min = Math.min(...data.map((d) => d.v), 0);
    const span = max - min || 1;
    const y0 = padT + (max / span) * ph;
    const bw = W / data.length;
    const step = data.length > 12 ? Math.ceil(data.length / 12) : 1;
    return `<svg viewBox="0 0 ${W} ${h}" class="barsvg" preserveAspectRatio="none">
      <line x1="0" x2="${W}" y1="${y0}" y2="${y0}" stroke="#2a323d"/>
      ${data.map((d, i) => {
        const bh = Math.max(d.v === 0 ? 0 : 1.5, (Math.abs(d.v) / span) * ph);
        const y = d.v >= 0 ? y0 - bh : y0;
        const c = rel ? '#4aa3ff' : d.v >= 0 ? GREEN : RED;
        return `<g><rect x="${i * bw + bw * 0.14}" y="${y}" width="${bw * 0.72}" height="${bh}" rx="1.5" fill="${c}" opacity="${d.n === 0 ? 0.15 : 0.9}"><title>${U.esc(d.tip || d.l + ': ' + fmt(d.v))}</title></rect>
        ${i % step === 0 ? `<text x="${i * bw + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#7d8796">${d.l}</text>` : ''}</g>`;
      }).join('')}</svg>`;
  }

  function renderBody(st, a) {
    const reasonName = { tp: 'Take profit', sl: 'Stop loss', liq: 'Liquidation', market: 'Market close', limit: 'Limit close', stop: 'Stop order', manual: 'Manual' };
    const kpi = (l, v, cls = '', s = '') => `<div class="kpi"><span>${l}</span><b class="${cls}">${v}</b><em>${s}</em></div>`;
    const lsRow = (n, g) => `<tr><td>${n}</td><td>${g.n}</td><td>${pcp(g.winRate, 1)}</td><td>${fx(g.pf)}</td><td class="${U.cls(g.pnl)}">${fxs(g.pnl)}</td><td class="${U.cls(g.avg)}">${fxs(g.avg)}</td><td>${fx(g.fees)}</td></tr>`;
    const dowN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return `
    <div class="kpis">
      ${kpi('Net P&L', fxs(st.netPnl) + ' <small>USDT</small>', U.cls(st.netPnl), pc(st.ret) + ' return')}
      ${kpi('Win rate', pcp(st.winRate, 1), '', `${st.wins}W · ${st.losses}L${st.be ? ' · ' + st.be + 'BE' : ''}`)}
      ${kpi('Profit factor', fx(st.pf), st.pf >= 1 ? 'up' : st.pf < 1 ? 'down' : '', 'gross win / gross loss')}
      ${kpi('Expectancy', fxs(st.expectancy) + ' <small>/ trade</small>', U.cls(st.expectancy), Number.isFinite(st.expR) ? fx(st.expR) + 'R avg' : 'per closed trade')}
      ${kpi('Max drawdown', pcp(st.maxDD), st.maxDD < 0 ? 'down' : '', fx(st.maxDDUsd) + ' USDT')}
      ${kpi('Sharpe (daily)', fx(st.sharpe), '', 'Sortino ' + fx(st.sortino))}
      ${kpi('Payoff ratio', fx(st.payoff), '', `avg win ${fx(st.avgWin)} / loss ${fx(Math.abs(st.avgLoss))}`)}
      ${kpi('Trades', st.n, '', `${st.nDays} trading days`)}
    </div>

    <div class="card chart-card"><div class="card-h"><span>Equity curve · Drawdown · Daily P&amp;L</span><span class="dim">equity excludes deposits / withdrawals</span></div><div id="an-chart"></div></div>

    <div class="grid3">
      <div class="card"><div class="card-h">Performance</div>
        ${row('Net P&L', fxs(st.netPnl) + ' USDT', U.cls(st.netPnl))}
        ${row('Starting equity', fx(st.startEq))}${row('Current equity', fx(st.endEq))}
        ${row('Return', pc(st.ret), U.cls(st.ret))}
        ${row('CAGR', pc(st.cagr), U.cls(st.cagr), 'Annualised – only shown after 7+ days')}
        ${row('Gross profit', fx(st.grossWin), 'up')}${row('Gross loss', '-' + fx(st.grossLoss), 'down')}
        ${row('Fees paid', fx(st.fees), '', `Maker ${fx(st.makerFees)} · Taker ${fx(st.takerFees)}`)}
        ${row('Fees / gross profit', pcp(st.feesPct, 1))}
        ${row('Funding paid / received', fxs(st.funding, 3), U.cls(st.funding))}
        ${row('Best trade', fxs(st.best), 'up')}${row('Worst trade', fxs(st.worst), 'down')}
        ${row('Average trade', fxs(st.expectancy), U.cls(st.expectancy))}${row('Median trade', fxs(st.medianPnl), U.cls(st.medianPnl))}
        ${row('Best day', fxs(st.bestDay), 'up')}${row('Worst day', fxs(st.worstDay), 'down')}
        ${row('Average day', fxs(st.avgDay), U.cls(st.avgDay))}${row('Profitable days', pcp(st.winDays, 1))}
      </div>
      <div class="card"><div class="card-h">Risk</div>
        ${row('Max drawdown', pcp(st.maxDD), 'down')}${row('Max drawdown (USDT)', '-' + fx(st.maxDDUsd), 'down')}
        ${row('Current drawdown', pcp(st.curDD), st.curDD < 0 ? 'down' : '')}
        ${row('Longest drawdown', dur(st.ddLongest))}
        ${row('Sharpe ratio', fx(st.sharpe), '', 'Daily equity returns, annualised √365, rf = 0')}
        ${row('Sortino ratio', fx(st.sortino))}${row('Calmar ratio', fx(st.calmar))}
        ${row('Recovery factor', fx(st.recovery), '', 'Net P&L / max drawdown (USDT)')}
        ${row('Annualised volatility', pcp(st.annVol, 1))}
        ${row('Std. dev. per trade', fx(st.stdPnl))}
        ${row('Avg leverage', Number.isFinite(st.avgLev) ? st.avgLev.toFixed(1) + 'x' : '–')}
        ${row('Avg position size', fx(st.avgNotional) + ' USDT')}
        ${row('Avg return on margin', pc(st.avgRoe))}
        ${row('Avg MAE', pcp(st.avgMAE), 'down', 'Maximum adverse excursion – how far trades went against you')}
        ${row('Avg MFE', pcp(st.avgMFE), 'up', 'Maximum favourable excursion – best unrealised move')}
        ${row('Edge ratio (MFE/MAE)', fx(st.edgeRatio))}
      </div>
      <div class="card"><div class="card-h">Trade quality</div>
        ${row('Win rate', pcp(st.winRate, 2))}${row('Winning / losing trades', `${st.wins} / ${st.losses}`)}
        ${row('Average win', fx(st.avgWin), 'up')}${row('Average loss', fx(st.avgLoss), 'down')}
        ${row('Payoff ratio', fx(st.payoff), '', 'Average win ÷ average loss')}
        ${row('Profit factor', fx(st.pf))}
        ${row('Expectancy', fxs(st.expectancy) + ' USDT', U.cls(st.expectancy))}
        ${row('Expectancy (R)', Number.isFinite(st.expR) ? fx(st.expR) + 'R  (' + st.nR + ' trades)' : '–', '', 'Needs a stop-loss set on the trade')}
        ${row('Kelly criterion', pcp(st.kelly, 1), '', 'Optimal fraction to risk per trade given win rate and payoff')}
        ${row('SQN', fx(st.sqn), '', 'System Quality Number – mean / std × √N')}
        ${row('Max consecutive wins', st.maxWinStreak, 'up')}${row('Max consecutive losses', st.maxLossStreak, 'down')}
        ${row('Current streak', st.curStreak.n ? st.curStreak.n + (st.curStreak.type === 'W' ? ' wins' : ' losses') : '–', st.curStreak.type === 'W' ? 'up' : st.curStreak.type === 'L' ? 'down' : '')}
        ${row('Avg holding time', dur(st.avgHold))}${row('… winners', dur(st.avgHoldWin))}${row('… losers', dur(st.avgHoldLoss))}
      </div>
    </div>

    <div class="grid2">
      <div class="card"><div class="card-h">Long vs Short</div>
        <table class="mini-t"><thead><tr><th></th><th>Trades</th><th>Win rate</th><th>PF</th><th>Net P&amp;L</th><th>Avg</th><th>Fees</th></tr></thead><tbody>${lsRow('<span class="sd long">Long</span>', st.long)}${lsRow('<span class="sd short">Short</span>', st.short)}</tbody></table>
        <div class="card-h sub2">Exit reasons</div>
        <table class="mini-t"><thead><tr><th>Reason</th><th>Trades</th><th>Net P&amp;L</th></tr></thead><tbody>${Object.entries(st.reasons).map(([k, v]) => `<tr><td>${reasonName[k] || k}</td><td>${v.n}</td><td class="${U.cls(v.pnl)}">${fxs(v.pnl)}</td></tr>`).join('') || '<tr><td colspan="3" class="dim">–</td></tr>'}</tbody></table>
      </div>
      <div class="card"><div class="card-h">By symbol</div>
        <table class="mini-t"><thead><tr><th>Symbol</th><th>Trades</th><th>Win rate</th><th>PF</th><th>Net P&amp;L</th><th>Fees</th></tr></thead><tbody>${st.bySym.map((s) => `<tr><td><b>${s.sym}</b></td><td>${s.n}</td><td>${pcp(s.winRate, 1)}</td><td>${fx(s.pf)}</td><td class="${U.cls(s.pnl)}">${fxs(s.pnl)}</td><td>${fx(s.fees)}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">No closed trades yet</td></tr>'}</tbody></table>
      </div>
    </div>

    <div class="grid3">
      <div class="card"><div class="card-h">P&amp;L by hour of entry <span class="dim">local time</span></div>${barSvg(st.byHour.map((h) => ({ l: U.p2(h.k), v: h.pnl, n: h.n, tip: `${U.p2(h.k)}:00 – ${h.n} trades, ${fxs(h.pnl)} USDT, win rate ${h.n ? ((h.wins / h.n) * 100).toFixed(0) : 0}%` })))}</div>
      <div class="card"><div class="card-h">P&amp;L by weekday of entry</div>${barSvg(st.byDow.map((h) => ({ l: dowN[h.k], v: h.pnl, n: h.n, tip: `${dowN[h.k]} – ${h.n} trades, ${fxs(h.pnl)} USDT, win rate ${h.n ? ((h.wins / h.n) * 100).toFixed(0) : 0}%` })))}</div>
      <div class="card"><div class="card-h">Trade P&amp;L distribution</div>${barSvg(st.dist.map((b) => ({ l: Math.round((b.lo + b.hi) / 2), v: b.n, n: b.n, tip: `${fx(b.lo)} … ${fx(b.hi)} USDT: ${b.n} trades` })), { rel: true })}</div>
    </div>`;
  }

  function ensureChart() {
    const el = $('#an-chart');
    if (!el) return;
    if (An.chart && An.chart._el === el) return;
    if (An.chart) try { An.chart.remove(); } catch (e) { /* noop */ }
    const tick = (t, type) => {
      const d = new Date(t * 1000);
      return type === 0 ? String(d.getFullYear()) : type === 1 ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] : type === 2 ? String(d.getDate()) : U.p2(d.getHours()) + ':' + U.p2(d.getMinutes());
    };
    const c = LW.createChart(el, {
      autoSize: true,
      handleScroll: { mouseWheel: false },
      handleScale: { mouseWheel: false },
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a94a3', fontSize: 11, fontFamily: "Inter, system-ui, sans-serif", panes: { separatorColor: '#232b36', separatorHoverColor: '#33404f', enableResize: true } },
      grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      rightPriceScale: { borderColor: '#232b36' },
      timeScale: { borderColor: '#232b36', timeVisible: true, secondsVisible: false, tickMarkFormatter: tick },
      localization: { timeFormatter: (t) => U.fmtDT(t * 1000).slice(0, 16) },
      crosshair: { vertLine: { color: '#556070', labelBackgroundColor: '#2b3340' }, horzLine: { color: '#556070', labelBackgroundColor: '#2b3340' } },
    });
    c._el = el;
    eqS = c.addSeries(LW.AreaSeries, { lineColor: '#f7a600', topColor: 'rgba(247,166,0,0.28)', bottomColor: 'rgba(247,166,0,0.02)', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, title: 'Equity' }, 0);
    ddS = c.addSeries(LW.AreaSeries, { lineColor: RED, topColor: 'rgba(246,70,93,0.02)', bottomColor: 'rgba(246,70,93,0.35)', lineWidth: 1.5, invertFilledArea: false, priceFormat: { type: 'custom', formatter: (v) => v.toFixed(2) + '%', minMove: 0.01 }, title: 'Drawdown' }, 1);
    pnlS = c.addSeries(LW.HistogramSeries, { priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, title: 'Daily P&L' }, 2);
    try {
      const p = c.panes();
      p[0].setStretchFactor(3);
      p[1].setStretchFactor(1.2);
      p[2].setStretchFactor(1.2);
    } catch (e) { /* noop */ }
    An.chart = c;
  }

  const toSeries = (pts) => {
    const out = [];
    let last = -1;
    pts.forEach(([t, v]) => {
      const s = Math.floor(t / 1000);
      if (s === last) out[out.length - 1].value = v;
      else if (s > last) { out.push({ time: s, value: v }); last = s; }
    });
    return out;
  };

  An.render = (force) => {
    if (!$('#view-analytics').classList.contains('active')) return;
    const a = Engine.active();
    if (!$('#an-body') || shellFor === 'x') shell();
    if (!$('#an-range')) shell();
    if (!a) {
      $('#an-body').innerHTML = noAcct;
      return;
    }
    const now = Date.now();
    if (!force && now - lastRender < 1500) return;
    lastRender = now;
    const r = RANGES.find((x) => x[0] === An.range);
    const from = r[2] ? now - r[2] : 0;
    const m = Engine.metrics(a);
    const st = Stats.compute(a, { from, liveEquity: m.equity - a.flow });
    $('#an-acct').innerHTML = `<i class="dotc" style="background:${a.color}"></i>${U.esc(a.name)} · started ${U.fmtDate(a.createdAt)} with ${U.fmt(a.startBalance, 0)} USDT · fees ${(a.maker * 100).toFixed(3)}% / ${(a.taker * 100).toFixed(3)}%`;
    const keep = $('#an-chart');
    const scroll = $('#view-analytics').scrollTop;
    if (keep && An.chart) {
      // keep the chart DOM node alive: re-render everything around it
      const holder = keep;
      $('#an-body').innerHTML = renderBody(st, a);
      const fresh = $('#an-chart');
      fresh.replaceWith(holder);
    } else $('#an-body').innerHTML = renderBody(st, a);
    ensureChart();
    eqS.setData(toSeries(st.curve));
    ddS.setData(toSeries(st.dd));
    pnlS.setData(st.dailyPnl.map((d) => ({ time: Math.floor(d.t / 1000) + 43200 - 0, value: d.pnl, color: d.pnl >= 0 ? GREEN : RED })));
    if (force || !An._fitted || An._fitAcct !== a.id) {
      An.chart.timeScale().fitContent();
      An._fitted = true;
      An._fitAcct = a.id;
    }
    $('#view-analytics').scrollTop = scroll;
  };
  U.on('engine:change', () => An.render());
  U.on('engine:account', () => An.render(true));

  /* ================================================================ CALENDAR */
  const Cal = (window.CalendarView = { y: new Date().getFullYear(), m: new Date().getMonth(), mode: 'month' });
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  Cal.render = () => {
    const el = $('#view-calendar');
    if (!el.classList.contains('active')) return;
    const a = Engine.active();
    if (!a) return (el.innerHTML = noAcct);
    const days = Stats.dayMap(a);
    const sym = (v) => (v > 0 ? '+' : '') + U.fmt(v, Math.abs(v) >= 1000 ? 0 : 2);
    let max = 1e-9;
    days.forEach((d) => (max = Math.max(max, Math.abs(d.pnl))));
    const bg = (p) => (p > 0 ? `rgba(46,189,133,${0.1 + 0.45 * Math.min(1, p / max)})` : p < 0 ? `rgba(246,70,93,${0.1 + 0.45 * Math.min(1, -p / max)})` : 'transparent');

    const summarize = (pred) => {
      const ds = [...days.values()].filter(pred);
      const trades = ds.flatMap((d) => d.trades);
      const wins = trades.filter((t) => t.pnl > 0).length;
      return {
        pnl: ds.reduce((s, d) => s + d.pnl, 0), n: trades.length,
        wr: trades.length ? (wins / trades.length) * 100 : NaN,
        green: ds.filter((d) => d.pnl > 0).length, red: ds.filter((d) => d.pnl < 0).length,
        best: ds.length ? Math.max(...ds.map((d) => d.pnl)) : NaN, worst: ds.length ? Math.min(...ds.map((d) => d.pnl)) : NaN,
        fees: ds.reduce((s, d) => s + d.fees, 0),
      };
    };
    const head = (title, s) => `
      <div class="cal-head"><div class="cal-nav"><button class="btn sm" data-n="-1">‹</button><h2>${title}</h2><button class="btn sm" data-n="1">›</button><button class="btn sm" data-n="0">Today</button></div>
        <div class="seg" id="cal-mode"><button data-md="month" class="${Cal.mode === 'month' ? 'active' : ''}">Month</button><button data-md="year" class="${Cal.mode === 'year' ? 'active' : ''}">Year</button></div></div>
      <div class="kpis small">
        <div class="kpi"><span>P&amp;L</span><b class="${U.cls(s.pnl)}">${fxs(s.pnl)} <small>USDT</small></b><em>fees ${fx(s.fees)}</em></div>
        <div class="kpi"><span>Trades</span><b>${s.n}</b><em>win rate ${pcp(s.wr, 1)}</em></div>
        <div class="kpi"><span>Green / red days</span><b><span class="up">${s.green}</span> / <span class="down">${s.red}</span></b><em>&nbsp;</em></div>
        <div class="kpi"><span>Best day</span><b class="up">${fxs(s.best)}</b><em>&nbsp;</em></div>
        <div class="kpi"><span>Worst day</span><b class="down">${fxs(s.worst)}</b><em>&nbsp;</em></div>
      </div>`;

    if (Cal.mode === 'year') {
      const s = summarize((d) => d.key.startsWith(Cal.y + '-'));
      const mini = (mo) => {
        const first = new Date(Cal.y, mo, 1);
        const lead = (first.getDay() + 6) % 7;
        const dim = new Date(Cal.y, mo + 1, 0).getDate();
        const ms = summarize((d) => d.key.startsWith(`${Cal.y}-${U.p2(mo + 1)}-`));
        let cells = '';
        for (let i = 0; i < lead; i++) cells += '<i></i>';
        for (let d = 1; d <= dim; d++) {
          const k = `${Cal.y}-${U.p2(mo + 1)}-${U.p2(d)}`;
          const x = days.get(k);
          cells += `<i style="background:${x ? bg(x.pnl) : 'transparent'}" title="${k}${x ? ': ' + sym(x.pnl) + ' USDT, ' + x.n + ' trades' : ''}"></i>`;
        }
        return `<div class="ym" data-mo="${mo}"><div class="ym-h"><b>${MONTHS[mo].slice(0, 3)}</b><span class="${U.cls(ms.pnl)}">${ms.n ? fxs(ms.pnl) : ''}</span></div><div class="ym-g">${cells}</div><div class="ym-f">${ms.n} trades</div></div>`;
      };
      el.innerHTML = `<div class="cal-wrap">${head(String(Cal.y), s)}<div class="ym-grid">${Array.from({ length: 12 }, (_, i) => mini(i)).join('')}</div></div>`;
    } else {
      const prefix = `${Cal.y}-${U.p2(Cal.m + 1)}-`;
      const s = summarize((d) => d.key.startsWith(prefix));
      const first = new Date(Cal.y, Cal.m, 1);
      const lead = (first.getDay() + 6) % 7;
      const dim = new Date(Cal.y, Cal.m + 1, 0).getDate();
      const todayK = U.fmtDate(Date.now());
      let html = '<div class="cal-grid"><div class="cal-dow">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Week'].map((x) => `<span>${x}</span>`).join('') + '</div>';
      let wkPnl = 0, wkN = 0, wkDays = 0, col = 0, wkNo = 1;
      const flushWeek = () => {
        html += `<div class="cal-wk ${U.cls(wkPnl)}"><b>Week ${wkNo}</b><span>${wkN ? fxs(wkPnl) : '–'}</span><em>${wkN} trades</em></div>`;
        wkPnl = 0; wkN = 0; wkDays = 0; col = 0; wkNo++;
      };
      html += '<div class="cal-body">';
      for (let i = 0; i < lead; i++) { html += '<div class="cal-cell empty"></div>'; col++; }
      for (let d = 1; d <= dim; d++) {
        const k = prefix + U.p2(d);
        const x = days.get(k);
        if (x) { wkPnl += x.pnl; wkN += x.n; }
        html += `<div class="cal-cell ${x ? 'has' : ''} ${k === todayK ? 'today' : ''}" data-k="${k}" style="background:${x ? bg(x.pnl) : ''}"><span class="d">${d}</span>${x ? `<b class="${U.cls(x.pnl)}">${sym(x.pnl)}</b><em>${x.n} trade${x.n > 1 ? 's' : ''} · ${((x.wins / x.n) * 100).toFixed(0)}%</em>` : ''}</div>`;
        col++;
        if (col === 7) flushWeek();
      }
      if (col > 0) { while (col < 7) { html += '<div class="cal-cell empty"></div>'; col++; } flushWeek(); }
      html += '</div></div>';
      el.innerHTML = `<div class="cal-wrap">${head(`${MONTHS[Cal.m]} ${Cal.y}`, s)}${html}</div>`;
    }

    el.onclick = (e) => {
      const n = e.target.closest('[data-n]');
      if (n) {
        const v = +n.dataset.n;
        if (v === 0) { Cal.y = new Date().getFullYear(); Cal.m = new Date().getMonth(); }
        else if (Cal.mode === 'year') Cal.y += v;
        else { Cal.m += v; if (Cal.m < 0) { Cal.m = 11; Cal.y--; } if (Cal.m > 11) { Cal.m = 0; Cal.y++; } }
        return Cal.render();
      }
      const md = e.target.closest('[data-md]');
      if (md) { Cal.mode = md.dataset.md; return Cal.render(); }
      const ym = e.target.closest('.ym');
      if (ym) { Cal.m = +ym.dataset.mo; Cal.mode = 'month'; return Cal.render(); }
      const c = e.target.closest('.cal-cell.has');
      if (c) dayDialog(days.get(c.dataset.k));
    };
  };

  function dayDialog(d) {
    const md = (s) => (Feed.bySym[s] ? Feed.bySym[s].szDec : 2);
    const body = `<div class="day-sum"><b class="${U.cls(d.pnl)}">${fxs(d.pnl)} USDT</b><span>${d.n} trades · ${d.wins} wins · fees ${fx(d.fees)}</span></div>
      <table class="mini-t"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>ROE</th><th>Held</th></tr></thead><tbody>${d.trades
        .slice().sort((x, y) => x.closeTime - y.closeTime)
        .map((t) => `<tr><td class="dim">${U.fmtTime(t.closeTime)}</td><td>${t.sym}</td><td><span class="sd ${t.side}">${t.side}</span></td><td>${U.fmt(t.entry, U.pxDec(t.entry, md(t.sym)))}</td><td>${U.fmt(t.exit, U.pxDec(t.exit, md(t.sym)))}</td><td class="${U.cls(t.pnl)}"><b>${fxs(t.pnl)}</b></td><td class="${U.cls(t.roe)}">${pc(t.roe)}</td><td class="dim">${dur(t.closeTime - t.openTime)}</td></tr>`).join('')}</tbody></table>`;
    U.modal({ title: U.fmtDate(d.trades[0].closeTime) + ' – trades', width: 640, body });
  }

  U.on('engine:change', U.throttle(() => Cal.render(), 2000));
  U.on('engine:account', () => Cal.render());
})();
