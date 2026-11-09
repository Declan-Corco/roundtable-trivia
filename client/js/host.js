// Host screen: create a lobby, show the QR code, run the game on a big screen.
(() => {
  const { $, el, shape, showScreen, request, countdown, toast, watchConnection, storage, ordinal } = window.RT;
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
    const list = $('#set-list');
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
      const label = el(
        'label',
        { className: 'set-card upload' + (selected?.type === 'upload' ? ' selected' : ''), id: 'upload-card' },
        input,
        el('strong', { id: 'upload-title' }, selected?.type === 'upload' ? selected.title : '⬆ Upload a trivia file'),
        el('span', { className: 'desc', id: 'upload-desc' }, selected?.type === 'upload' ? `${selected.data.questions.length} questions · click to change` : '.json — see trivia/README.md')
      );
      cards.push(label);
    }
    list.replaceChildren(...cards);
    if (!selected && sets[0]) select({ type: 'server', id: sets[0].id });
    updateCreateBtn();
  }

  function select(choice) {
    selected = choice;
    document.querySelectorAll('.set-card').forEach((c) => {
      const isUpload = c.id === 'upload-card';
      c.classList.toggle('selected', isUpload ? choice.type === 'upload' : choice.type === 'server' && c.dataset.id === choice.id);
    });
    updateCreateBtn();
  }

  function updateCreateBtn() {
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
  socket.on('host:players', ({ players }) => {
    if (current?.phase === 'lobby') renderPlayers(players);
  });
  socket.on('host:answers', ({ answered, playerCount }) => {
    if (current?.phase === 'question') {
      $('#q-answered').textContent = answered;
      $('#q-answered-label').textContent = `of ${playerCount} answered`;
    }
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
        return renderScoreboard(state);
      case 'finished':
        return renderFinal(state);
    }
  }

  function renderLobby(s) {
    $('#join-url').textContent = s.joinUrl.replace(/^https?:\/\//, '').replace(/\/(join)?\?pin=\d+$/, '');
    $('#lobby-pin').textContent = s.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
    $('#qr').src = s.qr;
    $('#lobby-title').textContent = s.title;
    $('#lock-btn').textContent = s.locked ? '🔒 Locked' : 'Lock';
    renderPlayers(s.players);
    showScreen('screen-lobby');
  }

  function renderPlayers(players) {
    $('#player-count').textContent = players.length;
    $('#start-btn').disabled = players.length === 0;
    $('#waiting-msg').hidden = players.length > 0;
    $('#kick-hint').hidden = players.length === 0;
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
            p.name
          )
        )
      )
    );
  }

  function renderIntro(s) {
    $('#intro-counter').textContent = `Question ${s.index + 1} of ${s.total}`;
    $('#intro-question').textContent = s.question;
    $('#intro-double').hidden = s.points !== 'double';
    const bar = $('#intro-progress');
    stopTimer = countdown(s.timeLeft, s.introMs, (_sec, frac) => {
      bar.style.transform = `scaleX(${frac})`;
    });
    showScreen('screen-intro');
  }

  function renderQuestion(s, reveal) {
    $('#q-text').textContent = s.question;
    $('#q-progress').textContent = `${s.index + 1} / ${s.total}`;
    $('#q-pin').textContent = `PIN ${s.pin}`;
    $('#q-answered').textContent = s.answered;
    $('#q-answered-label').textContent = `of ${s.playerCount} answered`;

    // Answer tiles
    $('#q-answers').replaceChildren(
      ...s.answers.map((text, i) => {
        const isCorrect = reveal && s.correct.includes(i);
        return el(
          'div',
          { className: 'answer' + (reveal && !isCorrect ? ' dim' : ''), dataset: { i } },
          shape(i),
          el('span', {}, text),
          isCorrect ? el('span', { className: 'check', 'aria-label': 'correct' }, '✓') : null
        );
      })
    );

    // Middle: image while answering, results chart on reveal
    const media = $('#q-media');
    if (reveal) {
      media.replaceChildren(renderChart(s));
    } else if (s.image) {
      media.replaceChildren(el('img', { src: s.image, alt: '' }));
    } else {
      media.replaceChildren();
    }

    // Timer
    const timer = $('#q-timer');
    timer.style.visibility = reveal ? 'hidden' : 'visible';
    timer.classList.remove('low');
    if (!reveal) {
      stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => {
        timer.textContent = sec;
        timer.classList.toggle('low', sec <= 5 && sec > 0);
      });
    }

    const next = $('#q-next');
    next.textContent = reveal ? (s.isLast ? 'Final results' : 'Next') : 'Skip';
    next.classList.toggle('btn-primary', reveal);
    showScreen('screen-question');
  }

  function renderChart(s) {
    const max = Math.max(1, ...s.counts);
    const chart = el('div', { className: 'chart' });
    s.counts.forEach((count, i) => {
      const correct = s.correct.includes(i);
      const bar = el('div', { className: 'bar', style: 'height:0%' });
      chart.append(
        el(
          'div',
          { className: 'bar-wrap' + (correct ? '' : ' dim'), dataset: { i } },
          el('div', { className: 'bar-label' }, correct ? '✓' : '', String(count)),
          bar
        )
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          bar.style.height = `${Math.max(3, (count / max) * 85)}%`;
        })
      );
    });
    return chart;
  }

  function renderScoreboard(s) {
    $('#score-list').replaceChildren(
      ...s.top.map((p, i) =>
        el(
          'li',
          { style: `animation-delay:${i * 0.08}s` },
          el('span', { className: 'rank' }, i + 1),
          el('span', { className: 'name' }, p.name),
          p.streak >= 2 ? el('span', { className: 'streak', title: 'Answer streak' }, `🔥${p.streak}`) : null,
          p.delta ? el('span', { className: 'delta' }, `+${p.delta}`) : null,
          el('span', {}, p.score.toLocaleString())
        )
      )
    );
    $('#score-next').textContent = `Next question (${s.index + 2}/${s.total})`;
    showScreen('screen-scoreboard');
  }

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
    if (e.target.closest('input, textarea')) return;
    if (e.key !== ' ' && e.key !== 'ArrowRight' && e.key !== 'PageDown') return;
    const btn = ['#start-btn', '#q-next', '#score-next'].map((id) => $(id)).find((b) => b.offsetParent && !b.disabled);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });
})();
