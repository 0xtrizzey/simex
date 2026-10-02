/* SimEx – account switcher, account manager (unlimited accounts), deposit/withdraw, backup */
(function () {
  const Ac = (window.Accounts = {});
  const $ = U.$, $$ = U.$$;
  const SWATCHES = ['#f7a600', '#3b8cf0', '#a66bff', '#2ebd85', '#f6465d', '#14c4c4', '#e056a0', '#9aa4b2'];

  const summary = (a) => {
    const m = Engine.metrics(a);
    const st = Stats.compute(a, { liveEquity: m.equity - a.flow });
    return { m, st, ret: a.startBalance ? ((m.equity - a.flow) / a.startBalance - 1) * 100 : 0 };
  };

  /* ---------- header chip ---------- */
  Ac.updateChip = () => {
    const a = Engine.active();
    const chip = $('#acct-chip');
    if (!a) return (chip.innerHTML = '<span>Create account</span>');
    const m = Engine.metrics(a);
    const html = `<i class="dotc" style="background:${a.color}"></i><span class="ac-name">${U.esc(a.name)}</span><span class="ac-eq">${U.fmt(m.equity)} <em>USDT</em></span><svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
    if (chip._h !== html) {
      chip.innerHTML = html;
      chip._h = html;
    }
  };

  function openSwitcher() {
    const accts = Engine.accounts();
    const act = Engine.active();
    const html = `<div class="ac-list">${accts
      .map((a) => {
        const s = summary(a);
        return `<div class="ac-item ${act && a.id === act.id ? 'cur' : ''}" data-id="${a.id}"><i class="dotc" style="background:${a.color}"></i><div class="ac-i-main"><b>${U.esc(a.name)}</b><span>${U.fmt(s.m.equity)} USDT</span></div><span class="${U.cls(s.ret)}">${U.fmtPct(s.ret)}</span></div>`;
      })
      .join('')}</div><div class="ac-foot"><button class="btn sm" id="ac-new">+ New account</button><button class="btn sm" id="ac-manage">Manage…</button></div>`;
    const p = TradeUI.popover($('#acct-chip'), html, { align: 'right', cls: 'acct-pop' });
    p.onclick = (e) => {
      const it = e.target.closest('.ac-item');
      if (it) {
        Engine.setActive(it.dataset.id);
        TradeUI.closePopover();
      } else if (e.target.id === 'ac-new') {
        TradeUI.closePopover();
        Ac.form();
      } else if (e.target.id === 'ac-manage') {
        TradeUI.closePopover();
        Ac.manager();
      }
    };
  }

  /* ---------- create / edit ---------- */
  Ac.form = (id) => {
    const a = id ? Engine.acct(id) : null;
    const hasFills = a && a.fills.length > 0;
    let color = a ? a.color : SWATCHES[Engine.accounts().length % SWATCHES.length];
    const body = U.el(`<div class="form-grid">
      <label class="fld"><span>Account name</span><input id="af-name" value="${a ? U.esc(a.name) : 'Account ' + (Engine.accounts().length + 1)}" maxlength="32"></label>
      <label class="fld"><span>Account size (USDT) ${hasFills ? '<em class="dim">– locked after first trade (use Deposit)</em>' : ''}</span><input id="af-bal" type="number" min="1" step="any" value="${a ? a.startBalance : 10000}" ${hasFills ? 'disabled' : ''}></label>
      <label class="fld"><span>Fee preset</span><select id="af-preset"><option value="">Custom</option>${Object.keys(Engine.presets).map((k) => `<option>${k}</option>`).join('')}</select></label>
      <div class="two">
        <label class="fld"><span>Maker fee (%)</span><input id="af-maker" type="number" step="any" min="0" value="${a ? +(a.maker * 100).toFixed(5) : 0.02}"></label>
        <label class="fld"><span>Taker fee (%)</span><input id="af-taker" type="number" step="any" min="0" value="${a ? +(a.taker * 100).toFixed(5) : 0.055}"></label>
      </div>
      <label class="chk"><input type="checkbox" id="af-fund" ${!a || a.funding ? 'checked' : ''}><span>Simulate funding payments (hourly, real Hyperliquid rates)</span></label>
      <div class="fld"><span>Colour</span><div class="swatches" id="af-sw">${SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}" class="${c === color ? 'active' : ''}"></button>`).join('')}</div></div>
      <p class="hint">Fees apply to every fill: limit orders that rest in the book and TP orders pay the maker fee, market / stop / SL / liquidation pay the taker fee. Changing fees affects future fills only.</p></div>`);
    $('#af-preset', body).onchange = (e) => {
      const p = Engine.presets[e.target.value];
      if (p) {
        $('#af-maker', body).value = p.maker;
        $('#af-taker', body).value = p.taker;
      }
    };
    $('#af-sw', body).onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      color = b.dataset.c;
      $$('#af-sw button', body).forEach((x) => x.classList.toggle('active', x === b));
    };
    U.modal({
      title: a ? 'Edit account' : 'New account',
      width: 460,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: a ? 'Save' : 'Create account',
          cls: 'primary',
          onClick: () => {
            const name = $('#af-name', body).value.trim();
            const bal = parseFloat($('#af-bal', body).value);
            const maker = parseFloat($('#af-maker', body).value),
              taker = parseFloat($('#af-taker', body).value);
            if (!name) return U.toast('Enter a name', 'err'), false;
            if (!(bal > 0)) return U.toast('Account size must be greater than 0', 'err'), false;
            if (!(maker >= 0) || !(taker >= 0)) return U.toast('Fees must be 0 or higher', 'err'), false;
            const funding = $('#af-fund', body).checked;
            if (a) {
              const patch = { name, maker: maker / 100, taker: taker / 100, funding, color };
              if (!hasFills) patch.startBalance = bal;
              Engine.updateAccount(a.id, patch);
              U.toast('Account updated', 'ok');
            } else {
              const n = Engine.createAccount({ name, balance: bal, maker: maker / 100, taker: taker / 100, funding, color });
              Engine.setActive(n.id);
              U.toast(`Account “${U.esc(name)}” created with ${U.fmt(bal)} USDT`, 'ok');
            }
            Ac.updateChip();
            if (Ac._mgr) Ac.manager(true);
          },
        },
      ],
    });
  };

  /* ---------- manager ---------- */
  Ac.manager = (refresh) => {
    if (Ac._mgr) Ac._mgr.close();
    const cards = () =>
      Engine.accounts()
        .map((a) => {
          const s = summary(a);
          const act = Engine.active() && Engine.active().id === a.id;
          return `<div class="acm-card ${act ? 'cur' : ''}" data-id="${a.id}">
            <div class="acm-h"><i class="dotc" style="background:${a.color}"></i><b>${U.esc(a.name)}</b>${act ? '<span class="badge">ACTIVE</span>' : ''}<div class="spacer"></div>
              <span class="acm-eq">${U.fmt(s.m.equity)} <em>USDT</em></span></div>
            <div class="acm-stats">
              <div><span>Return</span><b class="${U.cls(s.ret)}">${U.fmtPct(s.ret)}</b></div>
              <div><span>Net P&amp;L</span><b class="${U.cls(s.st.netPnl)}">${U.fmtS(s.st.netPnl)}</b></div>
              <div><span>Win rate</span><b>${U.fmtPctPlain(s.st.winRate, 1)}</b></div>
              <div><span>Trades</span><b>${s.st.n}</b></div>
              <div><span>Start size</span><b>${U.fmt(a.startBalance, 0)}</b></div>
              <div><span>Maker / Taker</span><b>${(a.maker * 100).toFixed(3)} / ${(a.taker * 100).toFixed(3)}%</b></div>
            </div>
            <div class="acm-btns"><button class="btn sm ${act ? '' : 'primary'}" data-a="select" ${act ? 'disabled' : ''}>${act ? 'Selected' : 'Select'}</button><button class="btn sm" data-a="edit">Edit</button><button class="btn sm" data-a="reset">Reset</button><button class="btn sm danger" data-a="delete">Delete</button></div>
          </div>`;
        })
        .join('') || '<div class="empty-note">No accounts yet.</div>';
    const body = U.el(`<div><div class="acm-top"><span class="dim">Unlimited accounts – each one has its own size, fees, positions, stats and equity curve.</span><button class="btn primary sm" id="acm-new">+ New account</button></div><div class="acm-grid" id="acm-grid">${cards()}</div></div>`);
    const m = U.modal({ title: 'Accounts', width: 760, body, onClose: () => (Ac._mgr = null) });
    Ac._mgr = m;
    body.onclick = async (e) => {
      if (e.target.id === 'acm-new') return Ac.form();
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const id = b.closest('.acm-card').dataset.id;
      const a = Engine.acct(id);
      const redraw = () => ($('#acm-grid', body).innerHTML = cards());
      if (b.dataset.a === 'select') {
        Engine.setActive(id);
        redraw();
      } else if (b.dataset.a === 'edit') Ac.form(id);
      else if (b.dataset.a === 'reset') {
        if (await U.confirm(`Reset <b>${U.esc(a.name)}</b>? All positions, orders and trade history are deleted and the balance returns to ${U.fmt(a.startBalance)} USDT.`, { okLabel: 'Reset', danger: true })) {
          Engine.resetAccount(id);
          redraw();
        }
      } else if (b.dataset.a === 'delete') {
        if (await U.confirm(`Delete account <b>${U.esc(a.name)}</b> permanently, including its whole trade history?`, { okLabel: 'Delete', danger: true })) {
          Engine.deleteAccount(id);
          if (!Engine.accounts().length) {
            m.close();
            return Ac.form();
          }
          redraw();
        }
      }
    };
  };

  /* ---------- deposit / withdraw ---------- */
  Ac.moneyDialog = (kind) => {
    const a = Engine.active();
    if (!a) return;
    const m = Engine.metrics(a);
    const body = U.el(`<div class="form-grid"><div class="kv"><span>Available</span><b>${U.fmt(m.avail)} USDT</b></div>
      <label class="fld"><span>Amount (USDT)</span><input id="mn-amt" type="number" min="0" step="any" autofocus></label>
      <p class="hint">${kind === 'deposit' ? 'Deposits do not count as profit in the equity curve and statistics.' : 'Withdrawals do not count as loss in the equity curve and statistics.'}</p></div>`);
    U.modal({
      title: (kind === 'deposit' ? 'Deposit to ' : 'Withdraw from ') + U.esc(a.name),
      width: 380,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: kind === 'deposit' ? 'Deposit' : 'Withdraw',
          cls: 'primary',
          onClick: () => {
            const v = parseFloat($('#mn-amt', body).value);
            const r = kind === 'deposit' ? Engine.deposit(a.id, v) : Engine.withdraw(a.id, v);
            if (!r.ok) return U.toast(r.error, 'err'), false;
            U.toast(`${kind === 'deposit' ? 'Deposited' : 'Withdrew'} ${U.fmt(v)} USDT`, 'ok');
          },
        },
      ],
    });
    setTimeout(() => $('#mn-amt', body).focus(), 50);
  };

  /* ---------- backup ---------- */
  function exportCsv() {
    const a = Engine.active();
    if (!a) return;
    const head = ['id', 'symbol', 'side', 'open_time', 'close_time', 'entry', 'exit', 'size', 'leverage', 'gross_pnl', 'fees', 'funding', 'net_pnl', 'roe_pct', 'mae_pct', 'mfe_pct', 'r_multiple', 'exit_reason'];
    const rows = a.trades.map((t) => [t.id, t.sym, t.side, new Date(t.openTime).toISOString(), new Date(t.closeTime).toISOString(), t.entry, t.exit, t.size, t.lev, t.gross, t.fees, t.funding, t.pnl, t.roe, t.mae, t.mfe, t.r == null ? '' : t.r, t.reason].join(','));
    U.download(`${a.name.replace(/\W+/g, '_')}_trades.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  }
  function openBackup() {
    const where = Engine.serverOk ? '<b class="up">Saved to disk</b> – <code>data/state.json</code> next to the app (plus a daily backup).' : '<b class="warn">Saved in this browser only.</b> Start the app with <code>start.bat</code> to also keep everything in a file on disk.';
    const p = TradeUI.popover($('#btn-data'), `<div class="menu-list wide"><div class="mi-note">${where}</div>
      <div class="mi" data-a="export">⬇ Export full backup (.json)</div>
      <div class="mi" data-a="import">⬆ Import backup…</div>
      <div class="mi" data-a="csv">⬇ Export trades of “${U.esc((Engine.active() || {}).name || '–')}” (.csv)</div></div>`, { align: 'right' });
    p.onclick = (e) => {
      const i = e.target.closest('[data-a]');
      if (!i) return;
      TradeUI.closePopover();
      if (i.dataset.a === 'export') U.download(`simex-backup-${U.fmtDate(Date.now())}.json`, Engine.exportJSON());
      else if (i.dataset.a === 'csv') exportCsv();
      else {
        const f = document.createElement('input');
        f.type = 'file';
        f.accept = '.json,application/json';
        f.onchange = async () => {
          try {
            const text = await f.files[0].text();
            if (await U.confirm('Importing replaces <b>all</b> current accounts and settings with the backup. Continue?', { okLabel: 'Import', danger: true })) {
              Engine.importJSON(text);
              U.toast('Backup imported', 'ok');
            }
          } catch (err) {
            U.toast('Import failed: ' + err.message, 'err');
          }
        };
        f.click();
      }
    };
  }

  Ac.init = () => {
    $('#acct-chip').onclick = openSwitcher;
    $('#acct-chip').dataset.pop = '1';
    $('#btn-data').onclick = openBackup;
    $('#btn-data').dataset.pop = '1';
    U.on('engine:account', Ac.updateChip);
    Ac.updateChip();
  };
})();
