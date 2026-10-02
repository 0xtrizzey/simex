/* SimEx – performance / quant statistics for one account */
(function () {
  const St = (window.Stats = {});
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map((x) => (x - m) * (x - m))) / (a.length - 1));
  };
  const median = (a) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };
  const dayStart = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  St.dayStart = dayStart;

  // equity curve (perf equity, excludes deposits/withdrawals) sliced to a range
  St.curve = (a, from, liveEq) => {
    let c = a.curve.slice();
    if (from > 0) {
      let before = null;
      const rest = [];
      for (const p of c) (p[0] < from ? (before = p) : rest.push(p));
      c = rest;
      if (before) c.unshift([from, before[1]]);
    }
    if (!c.length) c = [[Date.now(), a.startBalance]];
    if (liveEq != null) {
      const last = c[c.length - 1];
      const now = Date.now();
      if (now > last[0]) c.push([now, liveEq]);
      else last[1] = liveEq;
    }
    return c;
  };

  St.drawdown = (curve) => {
    let peak = curve[0][1], peakT = curve[0][0];
    let maxDD = 0, maxDDUsd = 0, longest = 0;
    const series = [];
    for (const [t, v] of curve) {
      if (v >= peak) {
        longest = Math.max(longest, t - peakT);
        peak = v;
        peakT = t;
      }
      const dd = peak > 0 ? (v / peak - 1) * 100 : 0;
      maxDD = Math.min(maxDD, dd);
      maxDDUsd = Math.max(maxDDUsd, peak - v);
      series.push([t, dd]);
    }
    const lastT = curve[curve.length - 1][0];
    longest = Math.max(longest, lastT - peakT);
    return { series, maxDD, maxDDUsd, cur: series[series.length - 1][1], longest, peak };
  };

  function group(T) {
    const n = T.length;
    const w = T.filter((t) => t.pnl > 0), l = T.filter((t) => t.pnl < 0);
    const gw = sum(w.map((t) => t.pnl)), gl = Math.abs(sum(l.map((t) => t.pnl)));
    return {
      n,
      wins: w.length,
      losses: l.length,
      winRate: n ? (w.length / n) * 100 : NaN,
      pnl: sum(T.map((t) => t.pnl)),
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
      avg: n ? sum(T.map((t) => t.pnl)) / n : NaN,
      avgWin: w.length ? gw / w.length : 0,
      avgLoss: l.length ? -gl / l.length : 0,
      fees: sum(T.map((t) => t.fees)),
    };
  }

  St.compute = (a, { from = 0, liveEquity = null } = {}) => {
    const T = a.trades.filter((t) => t.closeTime >= from).sort((x, y) => x.closeTime - y.closeTime);
    const n = T.length;
    const g = group(T);
    const wins = T.filter((t) => t.pnl > 0), losses = T.filter((t) => t.pnl < 0);
    const pnls = T.map((t) => t.pnl);
    const grossWin = sum(wins.map((t) => t.pnl));
    const grossLoss = Math.abs(sum(losses.map((t) => t.pnl)));
    const winRate = n ? (wins.length / n) * 100 : NaN;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? -grossLoss / losses.length : 0;
    const payoff = avgLoss ? avgWin / Math.abs(avgLoss) : avgWin ? Infinity : NaN;
    const wr = n ? wins.length / n : 0;
    const kelly = payoff && Number.isFinite(payoff) ? (wr - (1 - wr) / payoff) * 100 : NaN;
    const sd = std(pnls);

    // streaks
    let maxW = 0, maxL = 0, cw = 0, cl = 0;
    T.forEach((t) => {
      if (t.pnl > 0) { cw++; cl = 0; } else if (t.pnl < 0) { cl++; cw = 0; } else { cw = 0; cl = 0; }
      maxW = Math.max(maxW, cw);
      maxL = Math.max(maxL, cl);
    });
    const cur = cw ? { type: 'W', n: cw } : cl ? { type: 'L', n: cl } : { type: '-', n: 0 };

    // holding
    const hold = (arr) => (arr.length ? mean(arr.map((t) => t.closeTime - t.openTime)) : NaN);

    // equity based
    const curve = St.curve(a, from, liveEquity);
    const dd = St.drawdown(curve);
    const startEq = curve[0][1], endEq = curve[curve.length - 1][1];
    const ret = startEq ? (endEq / startEq - 1) * 100 : 0;
    const spanDays = Math.max(1e-9, (curve[curve.length - 1][0] - curve[0][0]) / 86400e3);

    // daily equity → returns
    const dEq = new Map();
    curve.forEach(([t, v]) => dEq.set(dayStart(t), v));
    const days = [...dEq.keys()].sort((x, y) => x - y);
    const filled = [];
    if (days.length) {
      let last = curve[0][1];
      for (let d = days[0]; d <= days[days.length - 1]; d += 86400e3) {
        const dd0 = dayStart(d + 3600e3);
        if (dEq.has(dd0)) last = dEq.get(dd0);
        filled.push(last);
      }
    }
    const rets = [];
    let prev = curve[0][1];
    // first day return relative to start equity
    filled.forEach((v) => {
      if (prev > 0) rets.push(v / prev - 1);
      prev = v;
    });
    const rMean = mean(rets), rStd = std(rets);
    const downs = rets.filter((r) => r < 0);
    const dsd = downs.length ? Math.sqrt(sum(downs.map((r) => r * r)) / rets.length) : 0;
    const enough = rets.length >= 3;
    const sharpe = enough && rStd > 0 ? (rMean / rStd) * Math.sqrt(365) : NaN;
    const sortino = enough && dsd > 0 ? (rMean / dsd) * Math.sqrt(365) : NaN;
    const years = spanDays / 365;
    const cagr = spanDays >= 7 && startEq > 0 && endEq > 0 ? (Math.pow(endEq / startEq, 1 / years) - 1) * 100 : NaN;
    const calmar = Number.isFinite(cagr) && dd.maxDD < 0 ? cagr / Math.abs(dd.maxDD) : NaN;
    const netPnl = sum(pnls);
    const recovery = dd.maxDDUsd > 0 ? netPnl / dd.maxDDUsd : NaN;

    // daily pnl (by close day)
    const dpMap = new Map();
    T.forEach((t) => {
      const k = dayStart(t.closeTime);
      const o = dpMap.get(k) || { t: k, pnl: 0, n: 0, wins: 0 };
      o.pnl += t.pnl;
      o.n++;
      if (t.pnl > 0) o.wins++;
      dpMap.set(k, o);
    });
    const dailyPnl = [...dpMap.values()].sort((x, y) => x.t - y.t);
    const dp = dailyPnl.map((d) => d.pnl);

    // by hour / weekday of entry
    const byHour = Array.from({ length: 24 }, (_, i) => ({ k: i, pnl: 0, n: 0, wins: 0 }));
    const byDow = Array.from({ length: 7 }, (_, i) => ({ k: i, pnl: 0, n: 0, wins: 0 }));
    T.forEach((t) => {
      const d = new Date(t.openTime);
      const h = byHour[d.getHours()];
      const w = byDow[(d.getDay() + 6) % 7];
      [h, w].forEach((o) => {
        o.pnl += t.pnl;
        o.n++;
        if (t.pnl > 0) o.wins++;
      });
    });

    // by symbol
    const sm = new Map();
    T.forEach((t) => {
      if (!sm.has(t.sym)) sm.set(t.sym, []);
      sm.get(t.sym).push(t);
    });
    const bySym = [...sm.entries()].map(([sym, arr]) => Object.assign({ sym }, group(arr))).sort((x, y) => y.pnl - x.pnl);

    // exit reasons
    const reasons = {};
    T.forEach((t) => {
      const r = (reasons[t.reason] ||= { n: 0, pnl: 0 });
      r.n++;
      r.pnl += t.pnl;
    });

    // distribution
    let dist = [];
    if (n) {
      const lo = Math.min(...pnls), hi = Math.max(...pnls);
      const bins = Math.min(14, Math.max(5, Math.ceil(Math.sqrt(n))));
      const w = hi === lo ? 1 : (hi - lo) / bins;
      dist = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, n: 0 }));
      pnls.forEach((p) => {
        const i = Math.min(bins - 1, Math.floor((p - lo) / w));
        dist[i].n++;
      });
    }

    const rs = T.filter((t) => t.r != null).map((t) => t.r);
    const makerFees = sum(a.fills.filter((f) => f.t >= from && f.liq === 'maker').map((f) => f.fee));
    const takerFees = sum(a.fills.filter((f) => f.t >= from && f.liq === 'taker').map((f) => f.fee));

    return {
      n, wins: wins.length, losses: losses.length, be: n - wins.length - losses.length,
      winRate, netPnl, grossWin, grossLoss,
      pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
      avgWin, avgLoss, payoff, kelly,
      expectancy: n ? netPnl / n : NaN,
      expR: rs.length ? mean(rs) : NaN,
      nR: rs.length,
      medianPnl: median(pnls),
      stdPnl: sd,
      sqn: sd > 0 ? (Math.sqrt(n) * mean(pnls)) / sd : NaN,
      best: n ? Math.max(...pnls) : NaN,
      worst: n ? Math.min(...pnls) : NaN,
      fees: sum(T.map((t) => t.fees)), makerFees, takerFees,
      funding: sum(T.map((t) => t.funding)),
      feesPct: grossWin > 0 ? (sum(T.map((t) => t.fees)) / grossWin) * 100 : NaN,
      maxWinStreak: maxW, maxLossStreak: maxL, curStreak: cur,
      avgHold: n ? mean(T.map((t) => t.closeTime - t.openTime)) : NaN,
      avgHoldWin: hold(wins), avgHoldLoss: hold(losses),
      avgLev: n ? mean(T.map((t) => t.lev)) : NaN,
      avgNotional: n ? mean(T.map((t) => t.notional)) : NaN,
      avgRoe: n ? mean(T.map((t) => t.roe)) : NaN,
      avgMAE: n ? mean(T.map((t) => t.mae)) : NaN,
      avgMFE: n ? mean(T.map((t) => t.mfe)) : NaN,
      edgeRatio: n && mean(T.map((t) => t.mae)) > 0 ? mean(T.map((t) => t.mfe)) / mean(T.map((t) => t.mae)) : NaN,
      startEq, endEq, ret, cagr, sharpe, sortino, calmar, recovery,
      annVol: enough ? rStd * Math.sqrt(365) * 100 : NaN,
      maxDD: dd.maxDD, maxDDUsd: dd.maxDDUsd, curDD: dd.cur, ddLongest: dd.longest,
      bestDay: dp.length ? Math.max(...dp) : NaN,
      worstDay: dp.length ? Math.min(...dp) : NaN,
      avgDay: dp.length ? mean(dp) : NaN,
      winDays: dp.length ? (dp.filter((x) => x > 0).length / dp.length) * 100 : NaN,
      nDays: dp.length,
      long: group(T.filter((t) => t.side === 'long')),
      short: group(T.filter((t) => t.side === 'short')),
      bySym, byHour, byDow, dist, reasons, dailyPnl, curve, dd: dd.series,
    };
  };

  // calendar helpers -----------------------------------------------------------------
  St.dayMap = (a) => {
    const m = new Map();
    a.trades.forEach((t) => {
      const k = U.dayKey(t.closeTime);
      const o = m.get(k) || { key: k, pnl: 0, n: 0, wins: 0, fees: 0, trades: [] };
      o.pnl += t.pnl;
      o.n++;
      o.fees += t.fees;
      if (t.pnl > 0) o.wins++;
      o.trades.push(t);
      m.set(k, o);
    });
    return m;
  };
})();
