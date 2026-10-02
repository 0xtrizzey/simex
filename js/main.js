/* SimEx – bootstrap */
(function () {
  const $ = U.$, $$ = U.$$;

  function showView(v) {
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
    ChartView.setVisible(v === 'trade');
    Engine.setPref('view', v);
    if (v === 'analytics') Analytics.render(true);
    if (v === 'calendar') CalendarView.render();
    if (v === 'trade') ChartView.resize();
  }

  function setStatus(ok) {
    const p = $('#feed-status');
    p.classList.toggle('ok', ok);
    p.classList.toggle('bad', !ok);
    $('.lbl', p).textContent = ok ? 'Hyperliquid · live' : 'Reconnecting…';
  }

  async function boot() {
    await Engine.load();
    if (!Engine.accounts().length) {
      Engine.createAccount({ name: 'Main', balance: 10000, maker: 0.0002, taker: 0.00055 });
    }

    let ok = false;
    while (!ok) {
      try {
        await Feed.loadMeta();
        ok = true;
      } catch (e) {
        $('#boot-msg').innerHTML = 'Could not reach Hyperliquid (' + U.esc(e.message) + ') – retrying…';
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    $('#boot-msg').textContent = 'Starting…';

    Feed.start();
    Accounts.init();
    TradeUI.init();
    $$('#nav button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
    showView(Engine.prefs().view || 'trade');

    // live prices → matching engine
    U.on('feed:mids', (changed) => {
      const watch = Engine.watched();
      changed.forEach((s) => watch.has(s) && Engine.onPrice(s, Feed.mid(s), Date.now(), { src: 'mids' }));
    });
    U.on('feed:status', setStatus);
    setStatus(Feed.connected);

    U.on('engine:caughtup', (r) => {
      U.toast(`Replayed ${U.fmtDur(r.gap)} while the app was closed (${r.interval} candles)${r.closed ? ` – <b>${r.closed} trade(s) closed</b>` : ' – no TP/SL/liquidation hit'}`, r.closed ? 'ok' : 'info', 8000);
    });
    await Engine.runCatchUp();

    setInterval(Engine.sample, 10000);
    setInterval(Engine.fundingTick, 5000);
    window.addEventListener('beforeunload', () => {
      Engine.S().lastTick = Date.now();
      const S = Engine.S();
      S.savedAt = Date.now();
      U.store.set('simex.v1', S);
      if (Engine.serverOk) navigator.sendBeacon('/api/state', new Blob([JSON.stringify(S)], { type: 'application/json' }));
    });
    document.addEventListener('visibilitychange', () => document.hidden && Engine.saveNow());

    $('#boot').classList.add('hide');
    setTimeout(() => $('#boot').remove(), 400);
  }

  boot().catch((e) => {
    console.error(e);
    $('#boot-msg').innerHTML = 'Startup error: ' + U.esc(e.message);
  });
})();
