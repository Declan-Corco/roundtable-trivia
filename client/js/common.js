// Helpers shared by the host screen and the player screen.
(function () {
  /** Answers are labelled A-D (index 0-3). */
  const LETTERS = ['A', 'B', 'C', 'D'];

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

  /** The answer's letter (A-D), shown on its plate. */
  function letter(i) {
    return el('span', { className: 'letter', 'aria-hidden': 'true' }, LETTERS[i] || '?');
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

  /**
   * Drains a progress bar smoothly from its current fill to empty over `msLeft` milliseconds.
   * Uses a CSS transition (runs on the GPU at the screen's refresh rate) instead of stepped updates.
   */
  function drainBar(bar, msLeft, totalMs) {
    const start = totalMs ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0;
    bar.style.transition = 'none';
    bar.style.transform = `scaleX(${start})`;
    void bar.offsetWidth; // commit the start position before animating
    bar.style.transition = `transform ${Math.max(0, msLeft)}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }

  /** Same as drainBar, for the SVG timer ring around the table (circle with pathLength="100"). */
  function drainRing(circle, msLeft, totalMs) {
    const start = totalMs ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0;
    circle.style.transition = 'none';
    circle.style.strokeDashoffset = String(100 * (1 - start));
    void circle.getBoundingClientRect();
    circle.style.transition = `stroke-dashoffset ${Math.max(0, msLeft)}ms linear`;
    circle.style.strokeDashoffset = '100';
  }

  // Seat colours go round the table like the logo: red, yellow, teal, red, …
  const SEAT_COLORS = ['red', 'yellow', 'teal'];
  const seatColor = (seat) => SEAT_COLORS[(Math.max(1, seat) - 1) % SEAT_COLORS.length];

  /**
   * Draws the seats around a round table. Seat N always sits in position N (clockwise from the top),
   * so a seat freed by a leaver stays visible as an empty spot until someone takes it.
   * `items` = [{ id, seat, cls, label?, name?, pop? }]; `tableSize` = how many seats to draw
   * (the server grows it when the table fills). Seat nodes are reused, so when the table grows the
   * existing seats glide round to their new spots and only new arrivals pop in.
   */
  function renderSeats(container, items, tableSize = 8) {
    container._seatArgs = [items, tableSize];
    const slots = Math.max(tableSize, ...items.map((it) => it.seat || 0), 1);
    const bySeat = new Map(items.map((it) => [it.seat, it]));
    const size = container.clientWidth || 400;
    const radius = 0.47; // fraction of the table-wrap's width
    const dot = Math.max(8, Math.min(40, ((2 * Math.PI * size * radius) / slots) * 0.6));

    // Add or remove seat nodes to match the table size; existing nodes keep their identity.
    while (container.children.length < slots) {
      const node = document.createElement('span');
      node.className = 'seat empty appear';
      container.append(node);
    }
    while (container.children.length > slots) container.lastElementChild.remove();

    const before = container._occupants || new Map(); // seat -> occupant id last time
    const now = new Map();
    [...container.children].forEach((node, i) => {
      const seat = i + 1;
      const it = bySeat.get(seat);
      const isNew = Boolean(it && it.pop && before.get(seat) !== it.id);
      if (it) now.set(seat, it.id);
      const appearing = node.classList.contains('appear') && !node.dataset.placed;
      node.className = 'seat ' + (it ? it.cls : 'empty') + (isNew ? ' pop' : '') + (appearing ? ' appear' : '');
      node.dataset.placed = '1';
      node.title = it?.name || '';
      node.textContent = it && dot >= 26 && it.label != null ? String(it.label) : '';
      const angle = -Math.PI / 2 + ((seat - 1) * 2 * Math.PI) / slots;
      node.style.left = `${50 + radius * 100 * Math.cos(angle)}%`;
      node.style.top = `${50 + radius * 100 * Math.sin(angle)}%`;
      node.style.width = node.style.height = `${dot}px`;
      node.style.fontSize = `${Math.round(dot * 0.42)}px`;
    });
    container._occupants = now;
  }
  window.addEventListener('resize', () => {
    document.querySelectorAll('.seats').forEach((c) => c._seatArgs && renderSeats(c, ...c._seatArgs));
  });

  /** An answer card: a coloured place setting with its letter on a plate, then the answer text. */
  function answerCard(i, text, tag = 'div', props = {}) {
    return el(
      tag,
      { className: 'answer', dataset: { i }, ...props },
      el('span', { className: 'plate' }, letter(i)),
      el('span', { className: 'label' }, text)
    );
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

  window.RT = { $, el, letter, showScreen, request, countdown, toast, watchConnection, storage, ordinal, LETTERS, MARK_SVG, drainBar, drainRing, seatColor, renderSeats, answerCard };
})();
