/* SimEx – shared helpers: DOM, formatting, event bus, modal / toast / context menu */
(function () {
  const U = (window.U = {});

  /* ---------- DOM ---------- */
  U.$ = (s, r = document) => r.querySelector(s);
  U.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  U.esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  U.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  U.debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  U.throttle = (fn, ms) => {
    let last = 0, t;
    return (...a) => {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn(...a);
      } else {
        clearTimeout(t);
        t = setTimeout(() => {
          last = Date.now();
          fn(...a);
        }, ms - (now - last));
      }
    };
  };

  /* ---------- event bus ---------- */
  const handlers = {};
  U.on = (evt, fn) => {
    (handlers[evt] ||= []).push(fn);
    return () => (handlers[evt] = handlers[evt].filter((f) => f !== fn));
  };
  U.emit = (evt, ...args) => {
    (handlers[evt] || []).slice().forEach((f) => {
      try {
        f(...args);
      } catch (e) {
        console.error('[bus]', evt, e);
      }
    });
  };

  /* ---------- number formatting ---------- */
  const nfCache = {};
  const nf = (d) => (nfCache[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  U.fmt = (n, d = 2) => (Number.isFinite(n) ? nf(d).format(Math.abs(n) < 0.5 * Math.pow(10, -d) ? 0 : n) : '–');
  U.fmtS = (n, d = 2) => (Number.isFinite(n) ? (n > 0 && U.fmt(n, d) !== U.fmt(0, d) ? '+' : '') + U.fmt(n, d) : '–');
  U.fmtPct = (n, d = 2) => (Number.isFinite(n) ? (n > 0 && n.toFixed(d) !== (0).toFixed(d) ? '+' : '') + n.toFixed(d) + '%' : '–');
  U.fmtPctPlain = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '–');
  U.fmtCompact = (n) => {
    if (!Number.isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(2);
  };
  U.cls = (n) => (n > 1e-9 ? 'up' : n < -1e-9 ? 'down' : '');

  // Hyperliquid style price precision (max 6 - szDecimals decimals, ~5-6 significant figs)
  U.pxDec = (price, szDec = 2) => {
    const maxDec = Math.max(0, 6 - szDec);
    if (!price || !Number.isFinite(price)) return maxDec;
    if (price >= 1) {
      const intDigits = Math.floor(Math.log10(price)) + 1;
      return Math.max(0, Math.min(maxDec, 6 - intDigits));
    }
    const lz = Math.floor(-Math.log10(price));
    return Math.min(maxDec, 5 + lz);
  };
  U.fmtPx = (p, dec) => (Number.isFinite(p) ? U.fmt(p, dec) : '–');
  U.fmtQty = (q, dec) => (Number.isFinite(q) ? q.toFixed(dec) : '–');
  U.floorTo = (x, dec) => {
    const m = Math.pow(10, dec);
    return Math.floor(x * m + 1e-9) / m;
  };
  U.roundTo = (x, dec) => {
    const m = Math.pow(10, dec);
    return Math.round(x * m) / m;
  };

  /* ---------- time formatting ---------- */
  const p2 = (n) => String(n).padStart(2, '0');
  U.p2 = p2;
  U.fmtDT = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  U.fmtDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  U.fmtTime = (ts) => {
    const d = new Date(ts);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  U.dayKey = (ts) => U.fmtDate(ts);
  U.fmtDur = (ms) => {
    if (!Number.isFinite(ms)) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  };

  /* ---------- storage ---------- */
  U.store = {
    get(k, def) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? def : JSON.parse(v);
      } catch (e) {
        return def;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch (e) {
        console.warn('storage failed', e);
        return false;
      }
    },
  };

  /* ---------- toast ---------- */
  U.toast = (msg, type = 'info', ms = 3800) => {
    const root = U.$('#toast-root');
    if (!root) return;
    const t = U.el(`<div class="toast ${type}"><span class="t-ic"></span><span class="t-msg">${msg}</span></div>`);
    root.append(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => {
      t.classList.remove('in');
      setTimeout(() => t.remove(), 250);
    }, ms);
  };

  /* ---------- modal ---------- */
  const modalStack = [];
  U.modal = ({ title = '', body = '', width = 480, actions = [], onClose, cls = '' }) => {
    const root = U.$('#modal-root');
    const wrap = U.el(
      `<div class="modal-back"><div class="modal ${cls}" style="width:${width}px"><div class="modal-h"><span class="modal-t">${title}</span><button class="icon-btn" data-x>✕</button></div><div class="modal-b"></div>${
        actions.length ? '<div class="modal-f"></div>' : ''
      }</div></div>`
    );
    const bodyEl = U.$('.modal-b', wrap);
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.append(body);
    const api = {
      el: wrap,
      body: bodyEl,
      $: (s) => bodyEl.querySelector(s),
      $$: (s) => Array.from(bodyEl.querySelectorAll(s)),
      close() {
        const i = modalStack.indexOf(api);
        if (i >= 0) modalStack.splice(i, 1);
        wrap.remove();
        onClose && onClose();
      },
    };
    const foot = U.$('.modal-f', wrap);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.onclick = () => {
        const r = a.onClick ? a.onClick(api) : undefined;
        if (r !== false && a.close !== false) api.close();
      };
      foot.append(b);
    });
    U.$('[data-x]', wrap).onclick = () => api.close();
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) api.close();
    });
    root.append(wrap);
    modalStack.push(api);
    return api;
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      U.closeMenu();
      const top = modalStack[modalStack.length - 1];
      if (top) top.close();
    }
  });

  U.confirm = (msg, { okLabel = 'Confirm', danger = false, title = 'Please confirm' } = {}) =>
    new Promise((res) => {
      let done = false;
      U.modal({
        title,
        width: 400,
        body: `<p class="confirm-msg">${msg}</p>`,
        actions: [
          { label: 'Cancel', onClick: () => ((done = true), res(false)) },
          { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: () => ((done = true), res(true)) },
        ],
        onClose: () => !done && res(false),
      });
    });

  /* ---------- context menu ---------- */
  U.closeMenu = () => {
    const m = U.$('#ctx-menu');
    if (m) {
      m.classList.remove('open');
      m.innerHTML = '';
    }
  };
  U.menu = (x, y, items) => {
    const m = U.$('#ctx-menu');
    m.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) return m.append(U.el('<div class="ctx-sep"></div>'));
      if (it.head) return m.append(U.el(`<div class="ctx-head">${it.head}</div>`));
      const d = U.el(`<div class="ctx-item ${it.cls || ''} ${it.disabled ? 'disabled' : ''}">${it.label}</div>`);
      if (!it.disabled)
        d.onclick = () => {
          U.closeMenu();
          it.onClick && it.onClick();
        };
      m.append(d);
    });
    m.classList.add('open');
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  };
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) U.closeMenu();
  });

  /* ---------- downloads ---------- */
  U.download = (name, text, mime = 'application/json') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
})();
