// Helpers shared by the host screen and the player screen.
(function () {
  const SHAPES = [
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 L29.5 27 H2.5 Z"/></svg>', // triangle
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 L30 16 L16 30 L2 16 Z"/></svg>', // diamond
    '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13.5"/></svg>', // circle
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="4" width="24" height="24" rx="2"/></svg>', // square
  ];
  const SHAPE_NAMES = ['Triangle', 'Diamond', 'Circle', 'Square'];

  // ---- Brand marks (inline SVG so they inherit the page's colours) ----
  // Six seats around the table: red top/bottom, yellow on the right-top/left-bottom, teal on the others.
  const SEATS = [
    [0, -1, 'red'], [0.866, -0.5, 'yellow'], [0.866, 0.5, 'teal'],
    [0, 1, 'red'], [-0.866, 0.5, 'yellow'], [-0.866, -0.5, 'teal'],
  ];
  const seats = (dist, r) =>
    SEATS.map(([x, y, c]) => `<circle cx="${(x * dist).toFixed(1)}" cy="${(y * dist).toFixed(1)}" r="${r}" class="d-${c}"/>`).join('');
  /** "The Table" mark: a wooden table with six coloured seats. */
  const MARK_SVG =
    `<svg viewBox="-50 -50 100 100" aria-hidden="true">${seats(40, 7.5)}` +
    '<circle r="24" class="t-top"/><circle r="13" class="t-ring"/></svg>';
  /** The "o" in the roundtable wordmark: a solid table with small seats. */
  const WORDMARK_O = `<svg class="wm-o" viewBox="-50 -50 100 100" aria-hidden="true">${seats(36, 6.5)}<circle r="20" class="t-solid"/></svg>`;

  /** Fills every [data-wordmark] with the logo and every .spinner with a spinning table. */
  function hydrateBrand(root = document) {
    root.querySelectorAll('[data-wordmark]').forEach((n) => {
      n.innerHTML = `r${WORDMARK_O}undtable`;
      n.setAttribute('aria-label', 'roundtable');
    });
    root.querySelectorAll('.spinner, [data-mark]').forEach((n) => (n.innerHTML = MARK_SVG));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrateBrand());
  else hydrateBrand();

  const $ = (sel, root = document) => root.querySelector(sel);

  /** Tiny element builder: el('div', {className: 'x', onclick}, 'text', childNode) */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k in node && k !== 'list') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function shape(i) {
    const span = el('span', { className: 'shape', title: SHAPE_NAMES[i] });
    span.innerHTML = SHAPES[i]; // static, trusted markup
    return span;
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.id !== id;
    });
    window.scrollTo(0, 0);
  }

  /** Emits a Socket.IO event and resolves with the server's {ok, error, ...} reply. */
  function request(socket, event, data) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, data || {}, (err, res) => {
        resolve(err ? { ok: false, error: 'The server did not respond. Check your connection.' } : res);
      });
    });
  }

  /** Counts down `ms` milliseconds, calling onTick(secondsLeft, fractionLeft). Returns a stop function. */
  function countdown(ms, totalMs, onTick, onDone) {
    const end = Date.now() + ms;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const left = Math.max(0, end - Date.now());
      onTick(Math.ceil(left / 1000), totalMs ? left / totalMs : 0);
      if (left <= 0) {
        stopped = true;
        clearInterval(id);
        if (onDone) onDone();
      }
    };
    const id = setInterval(tick, 100);
    tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }

  let toastTimer;
  function toast(message, ms = 3000) {
    let node = $('.toast');
    if (!node) {
      node = el('div', { className: 'toast', role: 'status' });
      document.body.append(node);
    }
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (node.hidden = true), ms);
  }

  /** Shows a red banner while the socket is disconnected. */
  function watchConnection(socket) {
    const banner = el('div', { className: 'conn-banner', hidden: true }, 'Reconnecting…');
    document.body.append(banner);
    socket.on('disconnect', () => (banner.hidden = false));
    socket.on('connect', () => (banner.hidden = true));
  }

  const storage = {
    get(store, key) {
      try {
        return JSON.parse(store.getItem(key) || 'null');
      } catch {
        return null;
      }
    },
    set(store, key, value) {
      try {
        store.setItem(key, JSON.stringify(value));
      } catch {}
    },
    remove(store, key) {
      try {
        store.removeItem(key);
      } catch {}
    },
  };

  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  window.RT = { $, el, shape, showScreen, request, countdown, toast, watchConnection, storage, ordinal, SHAPE_NAMES, MARK_SVG };
})();
