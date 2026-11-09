// Player screen: join with a PIN + nickname, then use the phone as an answer controller.
(() => {
  const { $, el, shape, showScreen, request, countdown, toast, watchConnection, storage, ordinal } = window.RT;
  const SESSION_KEY = 'rt_player_session';
  const socket = io();
  watchConnection(socket);

  let urlPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '');
  let inGame = false;
  let stopTimer = null;
  let lastChoice = null;
  let wakeLock = null;

  // ------------------------------------------------------------- join

  function showJoin(message = '') {
    inGame = false;
    stopTimer?.();
    setResultTheme(null);
    $('#player-bar').hidden = true;
    $('#join-error').textContent = message;
    const pinInput = $('#pin-input');
    if (!pinInput.value && urlPin) pinInput.value = urlPin;
    showScreen('screen-join');
    (pinInput.value ? $('#name-input') : pinInput).focus({ preventScroll: true });
  }

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#join-btn');
    const pin = $('#pin-input').value.replace(/\D/g, '');
    const name = $('#name-input').value.trim();
    if (pin.length !== 6) return ($('#join-error').textContent = 'The game PIN has 6 digits.');
    if (!name) return ($('#join-error').textContent = 'Please choose a nickname.');
    btn.disabled = true;
    const res = await request(socket, 'player:join', { pin, name });
    btn.disabled = false;
    if (!res.ok) return ($('#join-error').textContent = res.error);
    storage.set(localStorage, SESSION_KEY, { pin: res.pin, token: res.token });
    keepAwake();
    // The server now sends player:state with the lobby screen.
  });

  function clearSession() {
    storage.remove(localStorage, SESSION_KEY);
    inGame = false;
    releaseWakeLock();
  }

  // ------------------------------------------------------------- server events

  socket.on('connect', async () => {
    const session = storage.get(localStorage, SESSION_KEY);
    if (session && (!urlPin || urlPin === session.pin)) {
      const res = await request(socket, 'player:rejoin', session);
      if (res.ok) {
        keepAwake();
        return;
      }
      clearSession();
    }
    if (!inGame) showJoin();
  });

  socket.on('player:state', render);

  socket.on('player:kicked', () => {
    clearSession();
    showEnded('You were removed from the game by the host.');
  });

  socket.on('game:ended', ({ reason }) => {
    clearSession();
    showEnded(reason || 'The game has ended.');
  });

  function showEnded(message) {
    stopTimer?.();
    setResultTheme(null);
    $('#player-bar').hidden = true;
    $('#ended-msg').textContent = message;
    showScreen('screen-ended');
  }

  // ------------------------------------------------------------- rendering

  function render(s) {
    inGame = true;
    stopTimer?.();
    stopTimer = null;
    $('#player-bar').hidden = false;
    $('#bar-name').textContent = s.name;
    $('#bar-score').textContent = s.score.toLocaleString();
    setResultTheme(s.phase === 'result' ? (s.correct ? 'good' : 'bad') : null);

    switch (s.phase) {
      case 'lobby':
        $('#lobby-name').textContent = s.name;
        $('#lobby-title').textContent = s.title;
        return showScreen('screen-lobby');

      case 'intro': {
        $('#intro-counter').textContent = `Question ${s.index + 1} of ${s.total}`;
        $('#intro-double').hidden = s.points !== 'double';
        const bar = $('#intro-progress');
        stopTimer = countdown(s.timeLeft, 4000, (_sec, frac) => (bar.style.transform = `scaleX(${frac})`));
        return showScreen('screen-intro');
      }

      case 'question':
        return renderQuestion(s);

      case 'answered': {
        const holder = $('#answered-shape');
        holder.replaceChildren();
        if (lastChoice != null) {
          holder.append(el('div', { className: 'answer', dataset: { i: lastChoice }, style: 'padding:18px;font-size:2.4rem' }, shape(lastChoice)));
        }
        return showScreen('screen-answered');
      }

      case 'wait':
        return showScreen('screen-wait');

      case 'result':
        return renderResult(s);

      case 'finished':
        $('#final-rank').textContent = ordinal(s.rank);
        $('#final-detail').textContent =
          `out of ${s.playerCount} player${s.playerCount === 1 ? '' : 's'} · ${s.score.toLocaleString()} points · ` +
          `${s.correctCount}/${s.total} correct` +
          (s.rank === 1 ? ' 🏆' : s.rank <= 3 ? ' 🎉' : '');
        clearSession();
        inGame = true; // keep showing this screen until they choose to leave
        return showScreen('screen-final');
    }
  }

  function renderQuestion(s) {
    lastChoice = null;
    $('#p-qcounter').textContent = `${s.index + 1} of ${s.total}`;
    $('#p-qtext').textContent = s.question;
    const grid = $('#p-answers');
    grid.className = `answer-grid count-${s.answers.length}`;
    grid.replaceChildren(
      ...s.answers.map((text, i) =>
        el(
          'button',
          { type: 'button', className: 'answer', dataset: { i }, 'aria-label': `${RT.SHAPE_NAMES[i]}: ${text}`, onclick: () => answer(i) },
          shape(i),
          el('span', {}, text)
        )
      )
    );
    const timer = $('#p-timer');
    stopTimer = countdown(s.timeLeft, s.time * 1000, (sec) => {
      timer.textContent = sec;
      timer.classList.toggle('low', sec <= 5);
    });
    showScreen('screen-question');
  }

  async function answer(i) {
    const grid = $('#p-answers');
    if (grid.classList.contains('locked')) return;
    grid.classList.add('locked');
    grid.children[i]?.classList.add('chosen');
    lastChoice = i;
    navigator.vibrate?.(30);
    const res = await request(socket, 'player:answer', { index: i });
    if (!res.ok) {
      toast(res.error);
      if (/connection|respond/i.test(res.error)) {
        grid.classList.remove('locked');
        grid.children[i]?.classList.remove('chosen');
      }
    }
  }

  function renderResult(s) {
    const icon = $('#result-icon');
    if (!s.answered) {
      icon.textContent = '⏱';
      $('#result-title').textContent = "Time's up!";
    } else if (s.correct) {
      icon.textContent = '✓';
      $('#result-title').textContent = 'Correct!';
    } else {
      icon.textContent = '✗';
      $('#result-title').textContent = 'Incorrect';
    }
    $('#result-points').textContent = `+${s.points.toLocaleString()}`;
    $('#result-streak').textContent = s.streak >= 2 ? `🔥 Answer streak: ${s.streak}` : '';

    let rankText;
    if (s.rank === 1) rankText = `You're in 1st place! 🏆`;
    else if (s.behindBy === 0) rankText = `You're in ${ordinal(s.rank)} place, tied with ${s.behindName}`;
    else rankText = `You're in ${ordinal(s.rank)} place, ${s.behindBy.toLocaleString()} points behind ${s.behindName}`;
    $('#result-rank').textContent = rankText;
    if (s.correct) navigator.vibrate?.([40, 60, 40]);
    showScreen('screen-result');
  }

  function setResultTheme(kind) {
    document.body.classList.toggle('result-good', kind === 'good');
    document.body.classList.toggle('result-bad', kind === 'bad');
  }

  // ------------------------------------------------------------- buttons

  $('#leave-btn').addEventListener('click', async () => {
    await request(socket, 'player:leave');
    clearSession();
    showJoin();
  });
  function joinFresh() {
    clearSession();
    urlPin = '';
    $('#pin-input').value = '';
    history.replaceState(null, '', '/join');
    showJoin();
  }
  $('#again-btn').addEventListener('click', joinFresh);
  $('#ended-btn').addEventListener('click', joinFresh);

  // ------------------------------------------------------------- keep the phone awake during a game

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch {
      /* not supported or not allowed — that's fine */
    }
  }
  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && inGame) keepAwake();
  });
})();
