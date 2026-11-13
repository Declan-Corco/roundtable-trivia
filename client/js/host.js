// Host screen: set the table, seat the guests, run the game on a big screen.
(() => {
  const {
    $, el, showScreen, request, countdown, toast, watchConnection, storage, ordinal,
    drainBar, drainRing, seatColor, renderSeats, answerCard,
  } = window.RT;
  const SESSION_KEY = 'rt_host_session';
  const socket = io();
  watchConnection(socket);

  const PREFS_KEY = 'rt_host_setup_v3'; // last categories/settings per game, so hosts don't redo them
  let current = null; // last state received from the server
  let stopTimer = null;
  let stopAuto = null; // auto mode: the countdown on the current "next" button
  let catalog = []; // games offered by the server (/api/games)
  let choice = null; // { game, packs: Set<id>, upload: { data, title, count } | null, custom: '', settings: {} }

  /** True while the table is in the lobby waiting for the host to pick the next game. */
  const picking = () => current?.phase === 'lobby' && current.choosing;

  // ------------------------------------------------------------- setup: 1. pick a game

  /** The game picker: for a brand-new table, or (while `picking()`) the next game for this table. */
  async function showSetup() {
    const next = picking();
    if (!next) {
      current = null;
      stopTimer?.();
      $('#end-btn').hidden = true;
      showTopPin(null);
    }
    $('#setup-tagline').textContent = next ? 'Next game' : 'Set the table';
    $('#setup-note').hidden = !next;
    $('#create-btn').textContent = next ? 'Back to the lobby' : 'Open the lobby';
    $('#cancel-setup').hidden = !(next && current.hasRound);
    showScreen('screen-setup');
    $('#setup-error').textContent = '';
    try {
      const [cfg, data] = await Promise.all([
        fetch('/api/config').then((r) => r.json()),
        fetch('/api/games').then((r) => r.json()),
      ]);
      $('#host-password').hidden = !cfg.needsPassword || next; // already hosting: no password needed
      catalog = data.games;
      renderGames();
    } catch {
      $('#setup-error').textContent = 'Could not load the games from the server.';
    }
  }

  function renderGames() {
    $('#game-list').replaceChildren(
      ...catalog.map((g) => {
        const n = g.kind === 'wager' ? g.packs.length + (g.online?.categories.length || 0) : g.packs.reduce((sum, p) => sum + p.count, 0);
        const noun =
          g.kind === 'onlyone' ? `categor${n === 1 ? 'y' : 'ies'} to play`
          : g.kind === 'split' ? `question${n === 1 ? '' : 's'} to play`
          : g.kind === 'takedown' ? `prompt${n === 1 ? '' : 's'} to play`
          : `categor${n === 1 ? 'y' : 'ies'}`;
        return el(
          'button',
          { type: 'button', className: `game-card game-${g.id}`, onclick: () => openGame(g) },
          gameArt(g),
          el(
            'div',
            { className: 'game-text' },
            el('strong', {}, g.name),
            el('span', { className: 'desc' }, g.tagline),
            el('span', { className: 'count' }, `${n} ${noun}`)
          ),
          el('span', { className: 'go', 'aria-hidden': 'true' }, '→')
        );
      })
    );
  }

  /**
   * The game card's picture: a stack of betting chips (Wager Wars), a lone "1" among crossed-out
   * answers (Only One), a split bar with a guess pinned on it (Split Decision), or answer cards with
   * a crowned winner (Table Takedown).
   */
  function gameArt(g) {
    const art = el('div', { className: `game-art art-${g.kind}`, 'aria-hidden': 'true' });
    if (g.kind === 'takedown') {
      art.append(el('span', { className: 'td-art-card' }), el('span', { className: 'td-art-card' }), el('span', { className: 'td-art-card win' }, el('span', { className: 'td-art-crown' })));
    } else if (g.kind === 'split') {
      art.append(el('span', { className: 'sd-art-pin' }), el('span', { className: 'sd-art-bar' }, el('span'), el('span')));
    } else if (g.kind === 'onlyone') {
      art.append(el('span', { className: 'oo-art-x' }), el('span', { className: 'oo-art-x' }), el('span', { className: 'oo-art-one' }, '1'));
    } else {
      ['red', 'teal', 'yellow'].forEach((c) => art.append(el('span', { className: `chip-art s-${c}` })));
    }
    return art;
  }

  // ------------------------------------------------------------- setup: 2. categories & settings

  function openGame(game) {
    const saved = (storage.get(localStorage, PREFS_KEY) || {})[game.id] || {};
    const known = new Set([...game.packs.map((p) => p.id), ...(game.online?.categories || []).map((c) => c.id)]);
    let packs = new Set((saved.packs || []).filter((p) => known.has(p)));
    if (!packs.size) packs = new Set(game.defaultPacks.filter((p) => known.has(p)));
    if (!packs.size && game.packs[0]) packs.add(game.packs[0].id);
    const settings = {};
    for (const s of game.settings) {
      const v = saved.settings?.[s.id];
      settings[s.id] = s.options.some((o) => o.value === v) ? v : s.default;
    }
    choice = { game, packs, upload: null, custom: saved.custom || '', settings };

    $('#settings-art').replaceWith(Object.assign(gameArt(game), { id: 'settings-art' }));
    $('#settings-title').textContent = game.name;
    $('#settings-desc').textContent = game.description;
    $('#settings-error').textContent = '';
    $('#set-errors').replaceChildren(...game.errors.map((e) => el('div', {}, `⚠ Skipped ${e}`)));
    renderPacks();
    renderSettings();
    updateSummary();
    showScreen('screen-settings');
  }

  /** One category to tick: an icon, its name and a line about it. */
  function categoryCard({ id, icon, title, desc, meta }, i) {
    const on = choice.packs.has(id);
    return el(
      'button',
      {
        type: 'button',
        className: 'cat-card' + (on ? ' selected' : ''),
        'aria-pressed': String(on),
        onclick: () => {
          if (on) choice.packs.delete(id);
          else choice.packs.add(id);
          renderPacks();
          updateSummary();
        },
      },
      el('span', { className: 'cat-icon', dataset: { i: i % 4 }, 'aria-hidden': 'true' }, icon),
      el('span', { className: 'tick', 'aria-hidden': 'true' }, '✓'),
      el('span', { className: 'cat-title' }, title),
      desc ? el('span', { className: 'cat-desc' }, desc) : null,
      meta ? el('span', { className: 'cat-meta' }, meta) : null
    );
  }

  function renderPacks() {
    const { game, packs, upload } = choice;
    const picked = packs.size + (upload ? 1 : 0);
    $('#pack-hint').textContent = picked ? `${picked} picked · mix as many as you like` : 'Pick one or more to mix them';

    const blocks = [];
    const online = game.online;
    if (online) {
      // Popular Open Trivia DB categories (banked on the server); credited as its license requires.
      blocks.push(
        el(
          'div',
          { className: 'source' },
          el(
            'div',
            { className: 'cat-grid' },
            ...online.categories.map((c, i) => categoryCard({ id: c.id, icon: c.icon || '❓', title: c.title, desc: c.description }, i))
          ),
          el(
            'p',
            { className: 'credit-line' },
            'Questions from ',
            el('a', { href: online.url, target: '_blank', rel: 'noopener' }, online.name),
            ', licensed ',
            el('a', { href: online.licenseUrl, target: '_blank', rel: 'noopener' }, online.license),
            '.'
          )
        )
      );
    }

    // Question files on this server, and an upload of your own
    const files = game.packs.map((p, i) =>
      categoryCard({ id: p.id, icon: p.icon || '📄', title: p.title, desc: p.description, meta: `${p.count} ${game.packNoun}` }, i)
    );
    const uploadRow = game.allowUpload
      ? el(
          'label',
          { className: 'upload-row' + (upload ? ' selected' : '') },
          el('input', { type: 'file', accept: '.json,application/json', onchange: onUpload }),
          el('span', { className: 'upload-icon', 'aria-hidden': 'true' }, upload ? '✓' : '⬆'),
          el(
            'span',
            { className: 'upload-text' },
            el('span', { className: 'cat-title' }, upload ? upload.title : 'Upload a question file'),
            el('span', { className: 'cat-desc' }, upload ? `${upload.count} questions · click to change` : 'A .json file. The README shows the format.')
          ),
          upload
            ? el(
                'button',
                {
                  type: 'button',
                  className: 'link-btn',
                  onclick: (e) => {
                    e.preventDefault();
                    choice.upload = null;
                    renderPacks();
                    updateSummary();
                  },
                },
                'Remove'
              )
            : null
        )
      : null;
    if (files.length || uploadRow) {
      blocks.push(
        el(
          'div',
          { className: 'source' },
          online ? el('h3', { className: 'source-head' }, 'Your own questions') : null,
          files.length ? el('div', { className: 'cat-grid' }, ...files) : null,
          uploadRow
        )
      );
    }
    if (game.customPrompts) {
      // Only One / Split Decision: the host's own prompts, one per line. They're played first, in order.
      const box = el('textarea', {
        className: 'input custom-prompts',
        rows: 3,
        maxLength: 3000,
        placeholder: game.customPrompts.placeholder || '',
        value: choice.custom,
        oninput: (e) => {
          choice.custom = e.target.value;
          updateSummary();
        },
      });
      blocks.push(
        el(
          'div',
          { className: 'source' },
          el('h3', { className: 'source-head' }, 'Write your own'),
          el('p', { className: 'credit-line' }, game.customPrompts.help || 'One per line.'),
          box
        )
      );
    }
    $('#set-list').replaceChildren(...blocks);
  }

  /** A setting shown as a stepped slider (e.g. Manual · 10 sec · 30 sec · 1 min). */
  function sliderSetting(s) {
    const index = Math.max(0, s.options.findIndex((o) => o.value === choice.settings[s.id]));
    const value = el('strong', { className: 'slider-value' }, s.options[index].label);
    const marks = s.options.map((o, i) =>
      el(
        'button',
        {
          type: 'button',
          className: 'slider-mark' + (i === index ? ' on' : ''),
          onclick: () => {
            input.value = String(i);
            input.dispatchEvent(new Event('input'));
          },
        },
        o.label
      )
    );
    const input = el('input', {
      type: 'range',
      className: 'range setting-slider',
      min: 0,
      max: s.options.length - 1,
      step: 1,
      value: index,
      'aria-label': s.label,
      oninput: (e) => {
        const i = Number(e.target.value);
        choice.settings[s.id] = s.options[i].value;
        value.textContent = s.options[i].label;
        marks.forEach((m, k) => m.classList.toggle('on', k === i));
        updateSummary();
      },
    });
    input.style.setProperty('--steps', s.options.length - 1);
    return el(
      'div',
      { className: 'setting' },
      el('span', { className: 'setting-label slider-label' }, s.label, value, s.hint ? el('small', {}, s.hint) : null),
      input,
      el('div', { className: 'slider-marks' }, ...marks)
    );
  }

  function renderSettings() {
    $('#settings-list').replaceChildren(
      ...choice.game.settings.map((s) =>
        s.slider
          ? sliderSetting(s)
          : el(
          'div',
          { className: 'setting' },
          el('span', { className: 'setting-label' }, s.label, s.hint ? el('small', {}, s.hint) : null),
          el(
            'div',
            { className: 'seg', role: 'group', 'aria-label': s.label },
            ...s.options.map((o) =>
              el(
                'button',
                {
                  type: 'button',
                  className: o.value === choice.settings[s.id] ? 'on' : '',
                  'aria-pressed': String(o.value === choice.settings[s.id]),
                  onclick: () => {
                    choice.settings[s.id] = o.value;
                    renderSettings();
                    updateSummary();
                  },
                },
                o.label
              )
            )
          )
        )
      )
    );
  }

  const onlineChosen = () => [...choice.packs].filter((id) => id.includes(':'));

  /** The host's own prompts (Only One) or questions (Split Decision), one per line. */
  const customList = () => (choice.custom || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50);

  function updateSummary() {
    const { game, packs, upload, settings } = choice;
    const online = onlineChosen().length;
    const available =
      game.packs.filter((p) => packs.has(p.id)).reduce((n, p) => n + p.count, 0) + (upload?.count || 0) + (game.customPrompts ? customList().length : 0);
    let text;
    if (game.kind === 'onlyone') {
      const playing = Math.min(settings.count, available);
      text = available ? `${playing} round${playing === 1 ? '' : 's'} · ${settings.time}s each` : 'Pick a category, or write your own';
    } else if (game.kind === 'split') {
      const playing = Math.min(settings.count, available);
      text = available
        ? `${playing} round${playing === 1 ? '' : 's'} · ${settings.time}s to pick, ${settings.guessTime}s to guess`
        : 'Pick a question pack, or write your own';
    } else if (game.kind === 'takedown') {
      const playing = Math.min(settings.count, available);
      text = available
        ? `${playing} round${playing === 1 ? '' : 's'} · ${settings.time}s to write, ${settings.voteTime}s to vote`
        : 'Pick a prompt pack, or write your own';
    } else if (online) {
      const n = settings.count || 20;
      text = `${n} questions · from ${choice.packs.size + (choice.upload ? 1 : 0)} categor${choice.packs.size + (choice.upload ? 1 : 0) === 1 ? 'y' : 'ies'}`;
    } else if (available) {
      const playing = settings.count ? Math.min(settings.count, available) : available;
      text = `${playing} question${playing === 1 ? '' : 's'}${playing < available ? ` from ${available}` : ''}`;
    } else {
      text = 'Pick at least one category';
    }
    $('#round-summary').textContent = text;
    $('#create-btn').disabled = !online && !available;
  }

  $('#back-to-games').addEventListener('click', () => showScreen('screen-setup'));

  async function onUpload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#settings-error').textContent = '';
    try {
      if (file.size > 900_000) throw new Error('That file is too large (max ~900 KB).');
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('The file has no "questions" array.');
      choice.upload = { data, title: data.title || file.name.replace(/\.json$/i, ''), count: data.questions.length };
      renderPacks();
      updateSummary();
    } catch (err) {
      $('#settings-error').textContent = err instanceof SyntaxError ? `That file is not valid JSON: ${err.message}` : err.message;
    }
  }

  $('#create-btn').addEventListener('click', async () => {
    if (!choice) return;
    const btn = $('#create-btn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Opening…';
    $('#settings-error').textContent = '';
    const prefs = storage.get(localStorage, PREFS_KEY) || {};
    prefs[choice.game.id] = { packs: [...choice.packs], settings: choice.settings, custom: choice.custom };
    storage.set(localStorage, PREFS_KEY, prefs);
    const next = picking(); // the same table's next game, or a new table
    const res = await request(
      socket,
      next ? 'host:setup' : 'host:create',
      {
        game: choice.game.id,
        packs: [...choice.packs],
        customPrompts: choice.game.customPrompts ? customList() : undefined,
        customSet: choice.upload?.data,
        settings: choice.settings,
        password: $('#host-password').value,
      },
      120000
    );
    btn.textContent = label;
    btn.disabled = false;
    if (!res.ok) {
      $('#settings-error').textContent = res.error;
      return;
    }
    // The server now sends the lobby. A new table also gets a session, so a refresh rejoins it.
    if (!next) storage.set(sessionStorage, SESSION_KEY, { pin: res.pin, token: res.token });
  });

  $('#cancel-setup').addEventListener('click', () => send('host:cancel-setup'));

  // ------------------------------------------------------------- server events

  socket.on('connect', async () => {
    const session = storage.get(sessionStorage, SESSION_KEY);
    if (session) {
      const res = await request(socket, 'host:rejoin', session);
      if (res.ok) return;
      storage.remove(sessionStorage, SESSION_KEY);
      if (current) toast(res.error);
    }
    if (!current) showSetup();
  });

  socket.on('host:state', render);
  socket.on('host:players', ({ players, tableSize }) => {
    if (current?.phase === 'lobby') {
      Object.assign(current, { players, tableSize });
      renderGuests(players, tableSize);
    }
  });
  socket.on('host:answers', ({ phase, answered, answerCount, playerCount, seats, tableSize }) => {
    if (!current || current.phase !== phase) return;
    Object.assign(current, { seats, tableSize });
    if (phase === 'wager') {
      $('#w-label').textContent = `${answered} of ${playerCount} bets in`;
      renderAnswerSeats($('#w-seats'), seats, tableSize);
    } else if (phase === 'vote') {
      Object.assign(current, { answered });
      $('#td-label').textContent = `${answered} of ${playerCount} voted`;
    } else if (phase === 'question' && (current.kind === 'onlyone' || current.kind === 'takedown')) {
      Object.assign(current, { answered, answerCount });
      ooLabel(current);
      renderListSeats($('#oo-seats'), seats, tableSize);
    } else if (phase === 'question' || phase === 'guess') {
      $('#q-answered-label').textContent = `${answered} of ${playerCount} in`;
      renderAnswerSeats($('#q-seats'), seats, tableSize);
    }
  });
  socket.on('host:joined', ({ name }) => toast(`${name} joined the table`));
  socket.on('game:ended', ({ reason }) => {
    storage.remove(sessionStorage, SESSION_KEY);
    showEnded(reason);
  });
  socket.on('host:replaced', () => showEnded('This game is now being hosted from another tab.'));

  function showEnded(message) {
    current = null;
    stopTimer?.();
    $('#end-btn').hidden = true;
    showTopPin(null);
    $('#ended-msg').textContent = message;
    showScreen('screen-ended');
  }

  // ------------------------------------------------------------- rendering

  /** The PIN (and where to join) in the top-right corner whenever a table is open, for late joiners. */
  function showTopPin(s) {
    $('#top-pin').hidden = !s;
    if (!s) return;
    $('#top-url').textContent = s.joinUrl.replace(/^https?:\/\//, '').replace(/\/(join)?\?pin=\d+$/, '');
    $('#top-pin-code').textContent = s.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
  }

  /** Auto mode: "Standings in 8s" on the button, counting down to when the game moves on by itself. */
  function autoLabel(btn, label, auto) {
    stopAuto?.();
    stopAuto = null;
    btn.textContent = label;
    btn.classList.toggle('auto', !!auto);
    if (!auto) return;
    stopAuto = countdown(auto.left, auto.total, (sec) => (btn.textContent = `${label} in ${sec}s`));
  }

  function render(state) {
    const wasPicking = picking();
    stopTimer?.();
    stopTimer = null;
    stopAuto?.();
    stopAuto = null;
    current = state;
    $('#end-btn').hidden = false;
    showTopPin(state);
    switch (state.phase) {
      case 'lobby':
        // While the host picks the next game, stay on the picker (don't reset it on every update).
        if (state.choosing) return wasPicking ? undefined : showSetup();
        return renderLobby(state);
      case 'wager':
        return renderWager(state);
      case 'intro':
        return renderIntro(state);
      case 'question':
        return state.kind === 'onlyone' || state.kind === 'takedown' ? renderListRound(state) : renderQuestion(state, false);
      case 'moderating':
        return renderModerating(state);
      case 'vote':
        return renderTakedown(state, false);
      case 'guess': // Split Decision: the same screen as picking a side, now for guessing the split
        return renderQuestion(state, false);
      case 'grouping':
        return renderGrading(state);
      case 'review':
        return renderReview(state);
      case 'reveal':
        return state.kind === 'split' ? renderSplitReveal(state) : state.kind === 'takedown' ? renderTakedown(state, true) : renderQuestion(state, true);
      case 'scoreboard':
        return renderStandings(state);
      case 'finished':
        return renderFinal(state);
    }
  }

  // ---- Lobby: the PIN sits on the table and guests take seats around it

  function renderLobby(s) {
    $('#join-url').textContent = s.joinUrl.replace(/^https?:\/\//, '').replace(/\/(join)?\?pin=\d+$/, '');
    $('#lobby-pin').textContent = s.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
    $('#qr').src = s.qr;
    $('#lobby-title').textContent = `${s.gameName} · ${s.title}`;
    $('#lock-btn').textContent = s.locked ? '🔒 Locked' : 'Lock';
    showScreen('screen-lobby');
    renderGuests(s.players, s.tableSize);
  }

  function renderGuests(players, tableSize) {
    $('#player-count').textContent = players.length;
    $('#start-btn').disabled = players.length === 0;
    $('#waiting-msg').hidden = players.length > 0;
    $('#kick-hint').hidden = players.length === 0;

    renderSeats(
      $('#lobby-seats'),
      players.map((p) => ({
        id: p.id,
        seat: p.seat,
        cls: `taken s-${seatColor(p.seat)}${p.connected ? '' : ' away'}`,
        label: p.seat,
        name: p.name,
        pop: true,
      })),
      tableSize
    );

    $('#player-list').replaceChildren(
      ...players.map((p) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              className: p.connected ? '' : 'offline',
              title: `Remove ${p.name}`,
              onclick: async () => {
                const res = await request(socket, 'host:kick', { playerId: p.id });
                if (!res.ok) toast(res.error);
              },
            },
            el('span', { className: `seat-no s-${seatColor(p.seat)}` }, p.seat),
            p.name
          )
        )
      )
    );
  }

  // ---- Bets: the category is up, bets are coming in

  function renderWager(s) {
    $('#w-progress').textContent = `${s.gameName} · ${s.unit} ${s.index + 1} of ${s.total}`;
    $('#w-category').textContent = s.category || 'Mystery category';
    const tags = [];
    if (s.difficulty) tags.push(el('span', { className: 'chip' }, s.difficulty[0].toUpperCase() + s.difficulty.slice(1)));
    if (s.points === 'double') tags.push(el('span', { className: 'chip gold' }, 'Double winnings'));
    if (s.points === 'none') tags.push(el('span', { className: 'chip' }, 'Just for fun'));
    $('#w-tags').replaceChildren(...tags);
    $('#w-label').textContent = `${s.answered} of ${s.playerCount} bets in`;
    const table = $('#w-table');
    table.classList.remove('low');
    showScreen('screen-wager');
    drainRing($('#w-ring'), s.timeLeft, s.time * 1000);
    stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => {
      $('#w-timer').textContent = sec;
      table.classList.toggle('low', sec <= 5 && sec > 0);
    });
    renderAnswerSeats($('#w-seats'), s.seats, s.tableSize);
  }

  // ---- Intro

  function renderIntro(s) {
    $('#intro-counter').textContent = `${s.gameName} · ${s.unit} ${s.index + 1} of ${s.total}`;
    $('#intro-question').textContent = s.question;
    $('#intro-double').hidden = s.points !== 'double';
    showScreen('screen-intro');
    drainBar($('#intro-progress'), s.timeLeft, s.introMs);
  }

  // ---- Question & reveal: answers flank the table, seats show who's answered / what they chose

  function renderQuestion(s, reveal) {
    const stage = $('#q-stage');
    stage.classList.toggle('revealed', reveal);
    $('#q-progress').textContent =
      `${s.gameName} · ${s.unit} ${s.index + 1} of ${s.total}` + (s.points === 'double' ? ' · double winnings' : '');
    $('#q-text').textContent = s.question;
    // Online questions are credited to their database, as their licenses require.
    $('#q-credit').textContent = s.credit ? `Question: ${s.credit}` : '';
    $('#q-media').replaceChildren(s.image ? el('img', { src: s.image, alt: '' }) : '');
    $('#q-hint').textContent = questionHint(s, reveal);

    // Even-numbered answers sit on the left, odd on the right, all facing the table.
    const left = [];
    const right = [];
    s.answers.forEach((text, i) => {
      const card = answerCard(i, text);
      if (reveal) {
        const isCorrect = s.correct.includes(i);
        const pct = s.playerCount ? Math.round((s.counts[i] / s.playerCount) * 100) : 0;
        card.classList.toggle('dim', !isCorrect);
        card.classList.toggle('right', isCorrect);
        card.append(
          el('span', { className: 'count' }, String(s.counts[i])),
          el('span', { className: 'fill', style: `--pct:0%` })
        );
        if (isCorrect) card.querySelector('.plate').append(el('span', { className: 'tick', 'aria-label': 'correct' }, '✓'));
        requestAnimationFrame(() => requestAnimationFrame(() => card.querySelector('.fill').style.setProperty('--pct', pct + '%')));
      }
      (i % 2 === 0 ? left : right).push(card);
    });
    $('#q-left').replaceChildren(...left);
    $('#q-right').replaceChildren(...right);

    const ring = $('#q-ring');
    const timer = $('#q-timer');
    const table = $('#q-table');
    table.classList.remove('low');
    showScreen('screen-question');

    if (reveal) {
      ring.style.transition = 'none';
      ring.style.strokeDashoffset = '0';
      timer.textContent = '✓';
      $('#q-answered-label').textContent = `${s.correctCount} of ${s.playerCount} got it`;
      renderSeats(
        $('#q-seats'),
        s.seats.map((p) => ({ id: p.id, seat: p.seat, cls: p.choice == null ? 'none' : `c${p.choice}`, name: p.name, label: p.seat })),
        s.tableSize
      );
    } else {
      $('#q-answered-label').textContent = `${s.answered} of ${s.playerCount} in`;
      drainRing(ring, s.timeLeft, s.time * 1000);
      stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => {
        timer.textContent = sec;
        table.classList.toggle('low', sec <= 5 && sec > 0);
      });
      renderAnswerSeats($('#q-seats'), s.seats, s.tableSize);
    }

    const next = $('#q-next');
    if (reveal) autoLabel(next, s.isLast ? 'Final results' : 'Standings', s.auto);
    else {
      next.textContent = s.kind !== 'split' ? 'Skip' : s.phase === 'guess' ? 'Close guesses' : 'Close voting';
      next.classList.remove('auto');
    }
    next.classList.toggle('btn-primary', reveal);
  }

  /**
   * The line under the question: Split Decision says what to do on the phone; after a Wager Wars
   * reveal, the biggest swings each way.
   */
  function questionHint(s, reveal) {
    if (s.kind === 'split' && s.phase === 'question') return 'Pick a side on your phone. Nobody sees which one you picked.';
    if (s.kind === 'split' && s.phase === 'guess') {
      return `${s.votes} vote${s.votes === 1 ? '' : 's'} in. Now guess: what percent picked “${s.answers[0]}”?`;
    }
    if (!reveal || !s.bets) return '';
    const { biggestWin: w, biggestLoss: l } = s.bets;
    return [w && `Biggest win: ${w.name} ${RT.signed(w.points)}`, l && `Biggest loss: ${l.name} ${RT.signed(l.points)}`]
      .filter(Boolean)
      .join('  ·  ');
  }

  /** Only One: every table is seated; faded while typing, a ✓ once they're done. */
  function renderListSeats(container, seats, tableSize) {
    renderSeats(
      container,
      seats.map((p) => ({ id: p.id, seat: p.seat, cls: `taken s-${seatColor(p.seat)} ${p.answered ? 'in' : 'typing'}`, name: p.name, label: p.answered ? '✓' : p.seat })),
      tableSize
    );
  }

  function renderAnswerSeats(container, seats, tableSize) {
    renderSeats(
      container,
      seats.map((p) => ({ id: p.id, seat: p.seat, cls: p.answered ? `taken s-${seatColor(p.seat)} in` : 'waiting', name: p.name, label: p.seat })),
      tableSize
    );
  }

  // ---- Only One: tables type answers; then the host checks the groups

  function ooLabel(s) {
    const n = s.answerCount || 0;
    $('#oo-label').textContent =
      s.kind === 'takedown' ? `${s.answered} of ${s.playerCount} in` : `${n} answer${n === 1 ? '' : 's'} · ${s.answered} of ${s.playerCount} done`;
  }

  /** Only One's list round; Table Takedown's writing uses the same screen. */
  function renderListRound(s) {
    $('#oo-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#oo-category').textContent = s.category || '';
    $('#oo-prompt').textContent = s.question;
    $('#oo-rules').textContent =
      s.kind === 'takedown'
        ? 'Each table writes one answer on its phone. The answers go up with no names.'
        : 'Write as many as you can. Answers another table also wrote score nothing.';
    const table = $('#oo-table');
    table.classList.remove('low');
    showScreen('screen-oo');
    ooLabel(s);
    drainRing($('#oo-ring'), s.timeLeft, s.time * 1000);
    stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => {
      $('#oo-timer').textContent = sec;
      table.classList.toggle('low', sec <= 10 && sec > 0);
    });
    renderListSeats($('#oo-seats'), s.seats, s.tableSize);
  }

  /** Grading: the logo spins while the server matches answers and (when set up) reviews them. */
  function renderGrading(s) {
    $('#gr-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#gr-prompt').textContent = s.question;
    const n = s.answerCount || 0;
    $('#gr-count').textContent = `${n} answer${n === 1 ? '' : 's'} from ${s.playerCount} table${s.playerCount === 1 ? '' : 's'}`;
    const match = $('#gr-step-match');
    const review = $('#gr-step-review');
    match.className = s.step === 'matching' ? 'active' : 'done';
    review.hidden = !s.review;
    review.className = s.step === 'checking' ? 'active' : '';
    $('#gr-title').textContent = 'Grading answers…';
    $('#gr-steps').hidden = false;
    showScreen('screen-grading');
  }

  /** Table Takedown: writing is over and the last answers are being checked (the same spinning logo). */
  function renderModerating(s) {
    $('#gr-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#gr-prompt').textContent = s.question;
    $('#gr-title').textContent = 'Checking answers…';
    $('#gr-steps').hidden = true;
    const n = s.answerCount || 0;
    $('#gr-count').textContent = `${n} answer${n === 1 ? '' : 's'} from ${s.playerCount} table${s.playerCount === 1 ? '' : 's'}`;
    showScreen('screen-grading');
  }

  // ---- Table Takedown: the answers with no names while everyone votes (the host can take one down
  // if the filter missed something); then who wrote each, with its votes, the winner first.

  function renderTakedown(s, reveal) {
    const screen = $('#screen-td');
    screen.classList.toggle('revealed', reveal);
    $('#td-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#td-prompt').textContent = s.question;
    const winners = reveal ? s.answers.filter((a) => a.winner) : [];
    $('#td-hint').textContent = !s.answers.length
      ? s.filtered
        ? 'No answers made it past the filter this round.'
        : 'Nobody wrote an answer this round.'
      : !reveal
        ? 'Vote on your phone for the best one. Not your own!'
        : !winners.length
          ? 'No votes this round.'
          : `${winners.length > 1 ? 'A tie! ' : ''}${winners.map((w) => w.name).join(' & ')} win${winners.length > 1 ? '' : 's'} +${s.values.win}` +
            (s.backers ? ` · ${s.backers} table${s.backers === 1 ? '' : 's'} backed the winner (+${s.values.pick})` : '');

    $('#td-board').replaceChildren(
      ...s.answers.map((a, i) =>
        el(
          reveal ? 'div' : 'button',
          {
            className: `td-card${reveal && a.winner ? ' winner' : ''}${reveal && !a.winner ? ' lost' : ''}`,
            style: `animation-delay:${i * (reveal ? 0.12 : 0.06)}s`,
            type: reveal ? null : 'button',
            title: reveal ? null : 'Take this answer down',
            onclick: reveal
              ? null
              : async () => {
                  if (!confirm(`Take this answer down?\n\n“${a.text}”\n\nIts votes go back to the tables that cast them.`)) return;
                  const res = await request(socket, 'host:td-hide', { id: a.id });
                  if (!res.ok) toast(res.error);
                },
          },
          el('span', { className: 'td-label', dataset: { i: i % 4 } }, a.label),
          el('span', { className: 'td-text' }, a.text),
          reveal
            ? el(
                'span',
                { className: 'td-foot' },
                el('span', { className: 'td-by' }, el('span', { className: `seat-no s-${seatColor(a.seat)}` }, a.seat || '?'), a.name),
                el('span', { className: 'td-votes' }, `${a.votes} vote${a.votes === 1 ? '' : 's'}`)
              )
            : null,
          reveal && a.winner ? el('span', { className: 'td-crown', 'aria-label': 'Winner' }, '👑') : null
        )
      )
    );

    const next = $('#td-next');
    next.classList.toggle('btn-primary', reveal);
    if (reveal) {
      autoLabel(next, s.isLast ? 'Final results' : 'Standings', s.auto);
      $('#td-timer').textContent = '';
      $('#td-label').textContent = s.filtered ? `${s.filtered} answer${s.filtered === 1 ? '' : 's'} filtered` : '';
    } else {
      next.textContent = 'Close voting';
      next.classList.remove('auto');
      $('#td-label').textContent = `${s.answered} of ${s.playerCount} voted` + (s.filtered ? ` · ${s.filtered} filtered` : '');
      stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => ($('#td-timer').textContent = `${sec}s`));
    }
    showScreen('screen-td');
  }

  // ---- Results: the answers in three compact sections (unique, shared, rejected).
  // Tap an answer to select it; then tap another answer that means the same thing to merge them,
  // or use the bar: Not the same (split it out), Reject / Allow, Cancel.

  let selected = null; // the answer (entry id) the host has tapped

  async function reviewEdit(change) {
    const res = await request(socket, 'host:oo-edit', change);
    if (!res.ok) toast(res.error);
  }

  function renderReview(s) {
    $('#rv-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#rv-prompt').textContent = s.question;
    const where = new Map(); // entry id -> { g, e }
    for (const g of s.groups) for (const e of g.entries) where.set(e.id, { g, e });
    if (selected && !where.has(selected)) selected = null;

    const tap = (g, e) => {
      if (selected && selected !== e.id && where.get(selected).g.id !== g.id) {
        const from = where.get(selected).g.id;
        selected = null;
        reviewEdit({ action: 'merge', group: from, into: g.id }); // "these are the same answer"
        return;
      }
      selected = selected === e.id ? null : e.id;
      renderReview(current);
    };
    const chip = (g, e) =>
      el(
        'button',
        {
          type: 'button',
          className: 'rv-chip' + (e.id === selected ? ' sel' : '') + (e.rejected ? ' rej' : ''),
          title: `${e.name}${e.ai ? ` · ${e.why ? `rejected in review: ${e.why}` : 'changed in review'}` : ''}`,
          onclick: () => tap(g, e),
        },
        el('span', { className: `seat-no s-${seatColor(e.seat)}` }, e.seat || '?'),
        e.text
      );
    // One item per group: a single answer, or "Keurig = coffee maker" for answers that count as the same.
    const item = (g) => {
      const parts = [];
      g.entries.forEach((e, i) => {
        if (i) parts.push(el('span', { className: 'rv-eq', 'aria-hidden': 'true' }, '='));
        parts.push(chip(g, e));
      });
      const reviewed = g.ai || g.entries.some((e) => e.ai);
      if (reviewed) parts.push(el('span', { className: 'rv-tag', title: 'Changed in review' }, 'reviewed'));
      return el('span', { className: `rv-item ${g.status}` }, ...parts);
    };
    const seatOf = (g) => Math.min(...g.entries.map((e) => e.seat || 99));
    const byStatus = (st) => s.groups.filter((g) => g.status === st);
    const unique = byStatus('unique').sort((a, b) => seatOf(a) - seatOf(b) || a.entries[0].text.localeCompare(b.entries[0].text));
    // A table that wrote the same thing twice ("couch" and "sofa") scores it once: the first answer is
    // the unique one; the others are repeats, shown separately with no points.
    const repeats = [];
    const uniqueItems = unique.map((g) => {
      const counted = g.entries.find((e) => !e.rejected) || g.entries[0];
      for (const e of g.entries) {
        if (e === counted || e.rejected) continue;
        repeats.push(
          el(
            'span',
            { className: 'rv-item repeat' },
            chip(g, e),
            el('span', { className: 'rv-note' }, `same as ${counted.text}`),
            e.ai || g.ai ? el('span', { className: 'rv-tag', title: 'Changed in review' }, 'reviewed') : null
          )
        );
      }
      return el(
        'span',
        { className: 'rv-item unique' },
        chip(g, counted),
        g.ai ? el('span', { className: 'rv-tag', title: 'Changed in review' }, 'reviewed') : null
      );
    });
    const shared = byStatus('shared').sort((a, b) => b.entries.length - a.entries.length || a.entries[0].text.localeCompare(b.entries[0].text));
    const rejected = byStatus('rejected');
    const section = (cls, title, items) =>
      items.length
        ? el(
            'section',
            { className: `rv-sec ${cls}` },
            el('h3', {}, title, el('span', { className: 'rv-count' }, String(items.length))),
            el('div', { className: 'rv-flow' }, ...items)
          )
        : null;
    const board = [
      section('unique', `Unique · +${s.groups.find((g) => g.status === 'unique')?.points ?? 100} each`, uniqueItems),
      section('shared', 'Shared · no points', shared.map(item)),
      section('repeats', 'Repeats · no points', repeats),
      section('rejected', 'Rejected', rejected.map(item)),
    ].filter(Boolean);
    $('#rv-groups').replaceChildren(...(board.length ? board : [el('p', { className: 'muted rv-empty' }, 'Nobody wrote anything this round.')]));

    // The bar for the selected answer
    const sel = selected && where.get(selected);
    $('#rv-bar').hidden = !sel;
    $('#rv-hint').hidden = !!sel;
    $('#rv-hint').textContent = 'Tap an answer to change it.';
    if (sel) {
      $('#rv-sel').textContent = `“${sel.e.text}” (${sel.e.name}) · tap an answer that means the same, or`;
      $('#rv-split').hidden = sel.g.entries.length < 2;
      $('#rv-reject').textContent = sel.e.rejected ? 'Allow' : 'Reject';
    }

    autoLabel($('#rv-next'), s.isLast ? 'Score it · final results' : 'Score it', s.auto);
    // How the review went (only when answers are reviewed on this server)
    const ai = s.ai;
    const line = $('#rv-ai');
    line.hidden = !ai;
    line.className = `rv-status ${ai?.status || ''}`;
    if (ai?.status === 'done') {
      const did = [ai.rejected && `${ai.rejected} rejected`, ai.merged && `${ai.merged} merged`, ai.split && `${ai.split} split`].filter(Boolean);
      line.textContent = did.length ? `Answers reviewed: ${did.join(' · ')}` : 'Answers reviewed: no changes';
    } else if (ai?.status === 'error') line.textContent = `Answers couldn’t be reviewed (${ai.message})`;
    showScreen('screen-review');
  }

  $('#rv-cancel').addEventListener('click', () => {
    selected = null;
    if (current?.phase === 'review') renderReview(current);
  });
  $('#rv-split').addEventListener('click', () => {
    const id = selected;
    selected = null;
    if (id) reviewEdit({ action: 'split', entry: id });
  });
  $('#rv-reject').addEventListener('click', () => {
    const id = selected;
    selected = null;
    if (id) reviewEdit({ action: 'reject', entry: id });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected && current?.phase === 'review') {
      selected = null;
      renderReview(current);
    }
  });

  // ---- Split Decision reveal: the bar slides from 50/50 to the room's real split, then every
  // table's guess drops onto it as a pin in their seat colour; the closest guesses are listed below.

  function renderSplitReveal(s) {
    $('#sd-progress').textContent = `${s.gameName} · Round ${s.index + 1} of ${s.total}`;
    $('#sd-prompt').textContent = s.question;
    const [a, b] = s.answers;
    const none = s.actual == null;
    const pct = none ? 50 : s.actual;
    $('#sd-a-name').textContent = a;
    $('#sd-b-name').textContent = b;
    $('#sd-a-pct').textContent = none ? '' : `${pct}%`;
    $('#sd-b-pct').textContent = none ? '' : `${100 - pct}%`;
    const [na, nb] = s.counts;
    $('#sd-a-count').textContent = none ? '' : `${na} picked ${a}`;
    $('#sd-b-count').textContent = none ? '' : `${nb} picked ${b}`;
    const winners = s.guesses.filter((g) => g.closest);
    $('#sd-hint').textContent = none
      ? 'Nobody picked a side this round, so there was nothing to guess.'
      : !s.guesses.length
        ? `${s.votes} vote${s.votes === 1 ? '' : 's'}, but nobody guessed.`
        : `Closest: ${winners.map((g) => g.name).join(', ')}, ${winners[0].off ? `${winners[0].off}% off` : 'spot on'} · +${s.bonus} bonus`;

    // The bar starts at 50/50 and slides to the real split.
    const bar = $('#sd-bar');
    bar.classList.toggle('empty', none);
    bar.style.setProperty('--a', '50%');
    requestAnimationFrame(() => requestAnimationFrame(() => bar.style.setProperty('--a', `${pct}%`)));

    // Pins: guesses close together stack in rows so every seat number stays readable.
    const rows = [];
    const pins = [...s.guesses]
      .sort((x, y) => x.guess - y.guess)
      .map((g, i) => {
        let row = rows.findIndex((last) => g.guess - last >= 4.5);
        if (row === -1) row = rows.length < 4 ? rows.length : rows.indexOf(Math.min(...rows));
        rows[row] = g.guess;
        return el(
          'span',
          {
            className: `sd-pin s-${seatColor(g.seat)}${g.closest ? ' best' : ''}`,
            style: `left:${g.guess}%; --row:${row}; animation-delay:${0.9 + i * 0.05}s`,
            title: `${g.name}: ${g.guess}%`,
          },
          String(g.seat)
        );
      });
    $('#sd-pins').style.setProperty('--rows', Math.max(1, rows.length));
    $('#sd-pins').replaceChildren(...pins);

    // The closest guesses
    $('#sd-board').replaceChildren(
      ...s.guesses.slice(0, 6).map((g, i) =>
        el(
          'li',
          { className: g.closest ? 'best' : '', style: `animation-delay:${1.2 + i * 0.08}s` },
          el('span', { className: `seat-no s-${seatColor(g.seat)}` }, g.seat),
          el('span', { className: 'sd-who' }, g.name),
          el('span', { className: 'sd-guess' }, `${g.guess}%`),
          el('span', { className: 'sd-off' }, g.off ? `${g.off}% off` : 'spot on'),
          el('span', { className: 'sd-pts' }, `+${g.points}`)
        )
      )
    );
    autoLabel($('#sd-next'), s.isLast ? 'Final results' : 'Standings', s.auto);
    showScreen('screen-split');
  }

  // ---- Standings: each player's bar races from their old score to their new one

  function renderStandings(s) {
    $('#score-progress').textContent = `after ${s.unit.toLowerCase()} ${s.index + 1} of ${s.total}`;
    const max = Math.max(1, s.maxScore);
    const rows = s.top.map((p, i) => {
      const moved = s.index > 0 ? p.prevRank - p.rank : 0;
      const fill = el('div', { className: `fill s-${seatColor(p.seat)}` });
      fill.style.width = `${((p.score - p.delta) / max) * 100}%`;
      requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${(p.score / max) * 100}%`)));
      return el(
        'li',
        { style: `animation-delay:${i * 0.08}s` },
        el('span', { className: `seat-no big s-${seatColor(p.seat)}` }, p.rank),
        el(
          'div',
          { className: 'race-main' },
          el(
            'div',
            { className: 'race-name' },
            el('span', { className: 'name' }, p.name),
            moved > 0 ? el('span', { className: 'move up' }, `▲ ${moved}`) : null,
            moved < 0 ? el('span', { className: 'move down' }, `▼ ${-moved}`) : null,
            p.streak >= 2 ? el('span', { className: 'streak', title: 'Answer streak' }, `🔥 ${p.streak}`) : null
          ),
          el('div', { className: 'track' }, fill)
        ),
        el(
          'div',
          { className: 'race-score' },
          el('span', { className: 'score' }, p.score.toLocaleString()),
          p.delta ? el('span', { className: 'delta' + (p.delta < 0 ? ' down' : '') }, RT.signed(p.delta)) : null
        )
      );
    });
    $('#score-list').replaceChildren(...rows);
    autoLabel($('#score-next'), `Next ${s.unit.toLowerCase()} (${s.index + 2}/${s.total})`, s.auto);
    showScreen('screen-scoreboard');
  }

  // ---- Final

  function renderFinal(s) {
    $('#final-title').textContent = s.title;
    const medals = ['🥇', '🥈', '🥉'];
    $('#podium').replaceChildren(
      ...s.podium.slice(0, 3).map((p, i) =>
        el(
          'div',
          { className: `place p${i + 1}` },
          el('div', { className: 'pname' }, p.name),
          el(
            'div',
            { className: 'block' },
            el('span', { className: 'medal' }, medals[i]),
            el('span', { className: 'pscore' }, p.score.toLocaleString()),
            el('small', {}, p.stat)
          )
        )
      )
    );
    const rest = s.podium.slice(3);
    $('#runners-up').textContent = rest.length
      ? rest.map((p, i) => `${ordinal(i + 4)}: ${p.name} (${p.score.toLocaleString()})`).join('  ·  ')
      : '';
    showScreen('screen-final');
  }

  // ------------------------------------------------------------- controls

  async function send(event, data) {
    const res = await request(socket, event, data);
    if (!res.ok) toast(res.error);
    return res;
  }

  $('#start-btn').addEventListener('click', () => send('host:start'));
  $('#q-next').addEventListener('click', () => send('host:next'));
  $('#w-next').addEventListener('click', () => send('host:next'));
  $('#score-next').addEventListener('click', () => send('host:next'));
  $('#oo-next').addEventListener('click', () => send('host:next'));
  $('#rv-next').addEventListener('click', () => send('host:next'));
  $('#sd-next').addEventListener('click', () => send('host:next'));
  $('#td-next').addEventListener('click', () => send('host:next'));
  $('#lock-btn').addEventListener('click', () => send('host:lock', { locked: !current?.locked }));
  // Play again / change game: the table goes back to the lobby while the host picks the next game.
  $('#change-game-btn').addEventListener('click', () => send('host:reopen'));
  $('#new-game-btn').addEventListener('click', () => send('host:reopen'));

  async function endAndReset() {
    await request(socket, 'host:end');
    storage.remove(sessionStorage, SESSION_KEY);
    showSetup();
  }
  $('#ended-btn').addEventListener('click', showSetup);
  $('#end-btn').addEventListener('click', () => {
    if (current?.phase === 'finished' || confirm('End this game for everyone?')) endAndReset();
  });

  $('#fullscreen-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  // Space / → advances the game (handy with a presentation clicker).
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, button')) return;
    if (e.key !== ' ' && e.key !== 'ArrowRight' && e.key !== 'PageDown') return;
    const btn = ['#start-btn', '#w-next', '#q-next', '#oo-next', '#rv-next', '#sd-next', '#td-next', '#score-next'].map((id) => $(id)).find((b) => b.offsetParent && !b.disabled);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });
})();
