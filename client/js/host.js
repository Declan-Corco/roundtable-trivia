// Host screen: set the table, seat the guests, run the game on a big screen.
(() => {
  const {
    $, el, showScreen, request, countdown, toast, watchConnection, storage, ordinal,
    drainBar, drainRing, seatColor, renderSeats, answerCard,
  } = window.RT;
  const SESSION_KEY = 'rt_host_session';
  const socket = io();
  watchConnection(socket);

  const PREFS_KEY = 'rt_host_setup'; // last categories/settings, so hosts don't redo them
  let current = null; // last state received from the server
  let stopTimer = null;
  let catalog = []; // games offered by the server (/api/games)
  let choice = null; // { game, packs: Set<id>, upload: { data, title, count } | null, settings: {} }

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
        const n = g.packs.length + (g.online?.categories.length || 0);
        return el(
          'button',
          { type: 'button', className: `game-card game-${g.id}`, onclick: () => openGame(g) },
          gameArt(),
          el(
            'div',
            { className: 'game-text' },
            el('strong', {}, g.name),
            el('span', { className: 'desc' }, g.tagline),
            el('span', { className: 'count' }, `${n} categor${n === 1 ? 'y' : 'ies'}`)
          ),
          el('span', { className: 'go', 'aria-hidden': 'true' }, '→')
        );
      })
    );
  }

  /** The game card's picture: a stack of betting chips. */
  function gameArt() {
    const art = el('div', { className: 'game-art', 'aria-hidden': 'true' });
    ['red', 'teal', 'yellow'].forEach((c) => art.append(el('span', { className: `chip-art s-${c}` })));
    return art;
  }

  // ------------------------------------------------------------- setup: 2. categories & settings

  function openGame(game) {
    const saved = storage.get(localStorage, PREFS_KEY) || {};
    const known = new Set([...game.packs.map((p) => p.id), ...(game.online?.categories || []).map((c) => c.id)]);
    let packs = new Set((saved.packs || []).filter((p) => known.has(p)));
    if (!packs.size) packs = new Set(game.defaultPacks.filter((p) => known.has(p)));
    if (!packs.size && game.packs[0]) packs.add(game.packs[0].id);
    const settings = {};
    for (const s of game.settings) {
      const v = saved.settings?.[s.id];
      settings[s.id] = s.options.some((o) => o.value === v) ? v : s.default;
    }
    choice = { game, packs, upload: null, settings };

    $('#settings-art').replaceWith(Object.assign(gameArt(), { id: 'settings-art' }));
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
      // Popular Open Trivia DB categories, fetched live; credited as its license requires.
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
      categoryCard({ id: p.id, icon: '📄', title: p.title, desc: p.description, meta: `${p.count} questions` }, i)
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
    $('#set-list').replaceChildren(...blocks);
  }

  function renderSettings() {
    $('#settings-list').replaceChildren(
      ...choice.game.settings.map((s) =>
        el(
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

  function updateSummary() {
    const { game, packs, upload, settings } = choice;
    const online = onlineChosen().length;
    const available = game.packs.filter((p) => packs.has(p.id)).reduce((n, p) => n + p.count, 0) + (upload?.count || 0);
    let text;
    if (online) {
      const n = settings.count || 20;
      text = `${n} questions · fetched live when you open the lobby`;
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
    // Open Trivia DB allows one request every 5 seconds, so mixing its categories takes a moment.
    btn.textContent = onlineChosen().length ? 'Fetching questions…' : 'Opening…';
    $('#settings-error').textContent = '';
    storage.set(localStorage, PREFS_KEY, { packs: [...choice.packs], settings: choice.settings });
    const next = picking(); // the same table's next game, or a new table
    const res = await request(
      socket,
      next ? 'host:setup' : 'host:create',
      {
        packs: [...choice.packs],
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
  socket.on('host:answers', ({ phase, answered, playerCount, seats, tableSize }) => {
    if (!current || current.phase !== phase) return;
    Object.assign(current, { seats, tableSize });
    if (phase === 'wager') {
      $('#w-label').textContent = `${answered} of ${playerCount} bets in`;
      renderAnswerSeats($('#w-seats'), seats, tableSize);
    } else if (phase === 'question') {
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

  function render(state) {
    const wasPicking = picking();
    stopTimer?.();
    stopTimer = null;
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
        return renderQuestion(state, false);
      case 'reveal':
        return renderQuestion(state, true);
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
    $('#w-progress').textContent = `${s.gameName} · Question ${s.index + 1} of ${s.total}`;
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
    $('#intro-counter').textContent = `${s.gameName} · Question ${s.index + 1} of ${s.total}`;
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
      `${s.gameName} · Question ${s.index + 1} of ${s.total}` + (s.points === 'double' ? ' · double winnings' : '');
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
    next.textContent = reveal ? (s.isLast ? 'Final results' : 'Standings') : 'Skip';
    next.classList.toggle('btn-primary', reveal);
  }

  /** The line under the question: after the reveal, the biggest swings each way. */
  function questionHint(s, reveal) {
    if (!reveal || !s.bets) return '';
    const { biggestWin: w, biggestLoss: l } = s.bets;
    return [w && `Biggest win: ${w.name} ${RT.signed(w.points)}`, l && `Biggest loss: ${l.name} ${RT.signed(l.points)}`]
      .filter(Boolean)
      .join('  ·  ');
  }

  function renderAnswerSeats(container, seats, tableSize) {
    renderSeats(
      container,
      seats.map((p) => ({ id: p.id, seat: p.seat, cls: p.answered ? `taken s-${seatColor(p.seat)} in` : 'waiting', name: p.name, label: p.seat })),
      tableSize
    );
  }

  // ---- Standings: each player's bar races from their old score to their new one

  function renderStandings(s) {
    $('#score-progress').textContent = `after question ${s.index + 1} of ${s.total}`;
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
    $('#score-next').textContent = `Next question (${s.index + 2}/${s.total})`;
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
            el('small', {}, `${p.correct}/${s.total} correct`)
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
    const btn = ['#start-btn', '#w-next', '#q-next', '#score-next'].map((id) => $(id)).find((b) => b.offsetParent && !b.disabled);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });
})();
