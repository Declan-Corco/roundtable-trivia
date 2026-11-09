// Host screen: set the table, seat the guests, run the game on a big screen.
(() => {
  const {
    $, el, showScreen, request, countdown, toast, watchConnection, storage, ordinal,
    drainBar, drainRing, seatColor, renderSeats, answerCard,
  } = window.RT;
  const SESSION_KEY = 'rt_host_session';
  const socket = io();
  watchConnection(socket);

  let selected = null; // { type: 'server', id } | { type: 'upload', data, title }
  let current = null; // last state received from the server
  let stopTimer = null;
  let serverConfig = { needsPassword: false, allowUploads: true };

  // ------------------------------------------------------------- setup

  async function showSetup() {
    current = null;
    stopTimer?.();
    $('#end-btn').hidden = true;
    showScreen('screen-setup');
    $('#setup-error').textContent = '';
    try {
      const [cfg, data] = await Promise.all([
        fetch('/api/config').then((r) => r.json()),
        fetch('/api/sets').then((r) => r.json()),
      ]);
      serverConfig = cfg;
      $('#host-password').hidden = !cfg.needsPassword;
      renderSets(data.sets);
      $('#set-errors').replaceChildren(...data.errors.map((e) => el('div', {}, `⚠ Skipped ${e}`)));
    } catch {
      $('#setup-error').textContent = 'Could not load trivia sets from the server.';
    }
  }

  function renderSets(sets) {
    const cards = sets.map((s) =>
      el(
        'button',
        {
          type: 'button',
          className: 'set-card' + (selected?.type === 'server' && selected.id === s.id ? ' selected' : ''),
          onclick: () => select({ type: 'server', id: s.id }),
          dataset: { id: s.id },
        },
        el('strong', {}, s.title),
        s.description ? el('span', { className: 'desc' }, s.description) : null,
        el('span', { className: 'count' }, `${s.count} questions`)
      )
    );

    if (serverConfig.allowUploads) {
      const input = el('input', { type: 'file', accept: '.json,application/json', onchange: onUpload });
      cards.push(
        el(
          'label',
          { className: 'set-card upload' + (selected?.type === 'upload' ? ' selected' : ''), id: 'upload-card' },
          input,
          el('strong', { id: 'upload-title' }, selected?.type === 'upload' ? selected.title : '⬆ Upload a trivia file'),
          el(
            'span',
            { className: 'desc', id: 'upload-desc' },
            selected?.type === 'upload' ? `${selected.data.questions.length} questions · click to change` : '.json — see trivia/README.md'
          )
        )
      );
    }
    $('#set-list').replaceChildren(...cards);
    if (!selected && sets[0]) select({ type: 'server', id: sets[0].id });
    $('#create-btn').disabled = !selected;
  }

  function select(choice) {
    selected = choice;
    document.querySelectorAll('.set-card').forEach((c) => {
      const isUpload = c.id === 'upload-card';
      c.classList.toggle('selected', isUpload ? choice.type === 'upload' : choice.type === 'server' && c.dataset.id === choice.id);
    });
    $('#create-btn').disabled = !selected;
  }

  async function onUpload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#setup-error').textContent = '';
    try {
      if (file.size > 900_000) throw new Error('That file is too large (max ~900 KB).');
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('The file has no "questions" array.');
      const title = data.title || file.name.replace(/\.json$/i, '');
      selected = { type: 'upload', data, title };
      $('#upload-title').textContent = title;
      $('#upload-desc').textContent = `${data.questions.length} questions · click to change`;
      select(selected);
    } catch (err) {
      $('#setup-error').textContent = err instanceof SyntaxError ? `That file is not valid JSON: ${err.message}` : err.message;
    }
  }

  $('#create-btn').addEventListener('click', async () => {
    if (!selected) return;
    const btn = $('#create-btn');
    btn.disabled = true;
    $('#setup-error').textContent = '';
    const res = await request(socket, 'host:create', {
      setId: selected.type === 'server' ? selected.id : undefined,
      customSet: selected.type === 'upload' ? selected.data : undefined,
      password: $('#host-password').value,
    });
    btn.disabled = false;
    if (!res.ok) {
      $('#setup-error').textContent = res.error;
      return;
    }
    storage.set(sessionStorage, SESSION_KEY, { pin: res.pin, token: res.token });
  });

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
  socket.on('host:answers', ({ answered, playerCount, seats, tableSize }) => {
    if (current?.phase !== 'question') return;
    Object.assign(current, { seats, tableSize });
    $('#q-answered-label').textContent = `${answered} of ${playerCount} in`;
    renderAnswerSeats(seats, tableSize);
  });
  socket.on('game:ended', ({ reason }) => {
    storage.remove(sessionStorage, SESSION_KEY);
    showEnded(reason);
  });
  socket.on('host:replaced', () => showEnded('This game is now being hosted from another tab.'));

  function showEnded(message) {
    current = null;
    stopTimer?.();
    $('#end-btn').hidden = true;
    $('#ended-msg').textContent = message;
    showScreen('screen-ended');
  }

  // ------------------------------------------------------------- rendering

  function render(state) {
    stopTimer?.();
    stopTimer = null;
    current = state;
    $('#end-btn').hidden = false;
    switch (state.phase) {
      case 'lobby':
        return renderLobby(state);
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
    $('#lobby-title').textContent = s.title;
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

  // ---- Intro

  function renderIntro(s) {
    $('#intro-counter').textContent = `Question ${s.index + 1} of ${s.total}`;
    $('#intro-question').textContent = s.question;
    $('#intro-double').hidden = s.points !== 'double';
    showScreen('screen-intro');
    drainBar($('#intro-progress'), s.timeLeft, s.introMs);
  }

  // ---- Question & reveal: answers flank the table, seats show who's answered / what they chose

  function renderQuestion(s, reveal) {
    const stage = $('#q-stage');
    stage.classList.toggle('revealed', reveal);
    $('#q-progress').textContent = `Question ${s.index + 1} of ${s.total}` + (s.points === 'double' ? ' · double points' : '');
    $('#q-text').textContent = s.question;
    $('#q-pin').textContent = `Join with PIN ${s.pin}`;
    $('#q-media').replaceChildren(s.image ? el('img', { src: s.image, alt: '' }) : '');

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
      renderAnswerSeats(s.seats, s.tableSize);
    }

    const next = $('#q-next');
    next.textContent = reveal ? (s.isLast ? 'Final results' : 'Standings') : 'Skip';
    next.classList.toggle('btn-primary', reveal);
  }

  function renderAnswerSeats(seats, tableSize) {
    renderSeats(
      $('#q-seats'),
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
          p.delta ? el('span', { className: 'delta' }, `+${p.delta.toLocaleString()}`) : null
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
  $('#score-next').addEventListener('click', () => send('host:next'));
  $('#lock-btn').addEventListener('click', () => send('host:lock', { locked: !current?.locked }));

  async function endAndReset() {
    await request(socket, 'host:end');
    storage.remove(sessionStorage, SESSION_KEY);
    showSetup();
  }
  $('#new-game-btn').addEventListener('click', endAndReset);
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
    const btn = ['#start-btn', '#q-next', '#score-next'].map((id) => $(id)).find((b) => b.offsetParent && !b.disabled);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });
})();
