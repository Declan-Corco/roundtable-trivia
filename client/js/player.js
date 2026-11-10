// Player screen: join with a PIN + nickname, then use the phone as an answer controller.
// Depending on the game, the phone shows A-D buttons (Trivia, Majority Rules, Wager Wars), a bet
// slider (Wager Wars), A/B then a % slider (Split Decision), or a number keypad (Sticker Shock).
(() => {
  const { $, el, showScreen, request, countdown, toast, watchConnection, storage, ordinal, formatValue, signed } = window.RT;
  const SESSION_KEY = 'rt_player_session';
  const socket = io();
  watchConnection(socket);

  let urlPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '');
  let inGame = false;
  let stopTimer = null;
  let wakeLock = null;
  let current = null; // the last state from the server
  let phaseEnd = 0; // when the current bet / question closes (local clock)
  let phaseTotal = 0;

  // ------------------------------------------------------------- join

  function showJoin(message = '') {
    inGame = false;
    current = null;
    stopTimer?.();
    setResultTheme(null);
    $('#player-bar').hidden = true;
    $('#join-error').textContent = message;
    const pinInput = $('#pin-input');
    if (!pinInput.value && urlPin) pinInput.value = urlPin;
    showScreen('screen-join');
    (pinInput.value ? $('#name-input') : pinInput).focus({ preventScroll: true });
    offerApp();
  }

  // ------------------------------------------------------------- iOS app hand-off

  const inApp = () => document.documentElement.classList.contains('ios-app');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /** In iPhone Safari after scanning a QR code: offer to open the same game in the roundtable app. */
  function offerApp() {
    const link = $('#open-in-app');
    const pin = $('#pin-input').value.replace(/\D/g, '');
    link.hidden = !(isIOS && !inApp() && pin.length === 6);
    link.href = `roundtable://join?pin=${pin}`;
  }

  /** Inside the app: the native QR scanner opens the scanned game's join link. */
  $('#scan-btn').addEventListener('click', () => {
    try {
      window.webkit.messageHandlers.scan.postMessage('scan');
    } catch {
      toast('Scanning is only available in the roundtable app.');
    }
  });

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
    current = s;
    stopTimer?.();
    stopTimer = null;
    $('#player-bar').hidden = false;
    $('#bar-name').textContent = s.name;
    $('#bar-score').textContent = s.score.toLocaleString();
    if (s.phase !== 'result') setResultTheme(null);

    switch (s.phase) {
      case 'lobby':
        $('#lobby-seat').textContent = `Seat ${s.seat}`;
        $('#lobby-seat').className = `pc-seat s-${RT.seatColor(s.seat)}`;
        $('#lobby-name').textContent = s.name;
        $('#lobby-title').textContent = `${s.gameName} · ${s.title}`;
        return showScreen('screen-lobby');

      case 'wager':
        return renderWager(s);

      case 'intro': {
        $('#intro-counter').textContent = `${s.gameName} · Question ${s.index + 1} of ${s.total}`;
        $('#intro-double').hidden = s.points !== 'double';
        const wager = $('#intro-wager');
        wager.hidden = s.wager == null;
        wager.textContent = s.wager ? `Your bet: ${s.wager.toLocaleString()}` : 'No bet on this one';
        showScreen('screen-intro');
        RT.drainBar($('#intro-progress'), s.timeLeft, 4000);
        return;
      }

      case 'question':
        return s.input === 'number' ? renderNumber(s) : renderQuestion(s);

      case 'answered':
        return renderAnswered(s);

      case 'wait':
        return showScreen('screen-wait');

      case 'result':
        return renderResult(s);

      case 'finished':
        $('#final-rank').textContent = ordinal(s.rank);
        $('#final-detail').textContent =
          `out of ${s.playerCount} player${s.playerCount === 1 ? '' : 's'} · ${s.score.toLocaleString()} points · ` +
          `${s.correctCount}/${s.total} ${s.stat}` +
          (s.rank === 1 ? ' 🏆' : s.rank <= 3 ? ' 🎉' : '');
        clearSession();
        inGame = true; // keep showing this screen until they choose to leave
        return showScreen('screen-final');
    }
  }

  // ---- Timers: one countdown per bet / question, shown on whichever screen the phone is on

  function startPhase(s) {
    phaseEnd = Date.now() + s.timeLeft;
    phaseTotal = s.time * 1000;
  }

  /** Runs the countdown on a screen's timer (#<id>-timer) and time bar (#<id>-timebar). */
  function runTimer(id) {
    stopTimer?.();
    const timer = $(`#${id}-timer`);
    const bar = $(`#${id}-timebar`);
    const left = Math.max(0, phaseEnd - Date.now());
    RT.drainBar(bar, left, phaseTotal);
    stopTimer = countdown(left, phaseTotal, (sec) => {
      timer.textContent = `${sec}s`;
      bar.parentElement.classList.toggle('low', sec <= 5);
    });
  }

  const counter = (s) => `${s.index + 1} of ${s.total}` + (s.wager != null ? ` · bet ${s.wager.toLocaleString()}` : '');

  /** Sends an answer; `onRetry` undoes the locked look if it never reached the server. */
  async function sendAnswer(data, onRetry) {
    navigator.vibrate?.(30);
    const res = await request(socket, 'player:answer', data);
    if (!res.ok) {
      toast(res.error);
      if (/connection|respond/i.test(res.error)) onRetry?.();
    }
  }

  // ---- Wager Wars: bet on the category before the question is shown

  let wagerMax = 0;
  const QUICK = [
    ['Nothing', 0],
    ['¼', 0.25],
    ['½', 0.5],
    ['All in', 1],
  ];

  function renderWager(s) {
    startPhase(s);
    wagerMax = s.max;
    $('#w-counter').textContent = `${s.index + 1} of ${s.total}`;
    $('#w-category').textContent = s.category || 'Mystery category';
    const tags = [];
    if (s.difficulty) tags.push(el('span', { className: 'chip' }, s.difficulty[0].toUpperCase() + s.difficulty.slice(1)));
    if (s.points === 'double') tags.push(el('span', { className: 'chip gold' }, 'Double winnings'));
    tags.push(el('span', { className: 'chip' }, `You have ${s.score.toLocaleString()}`));
    $('#w-tags').replaceChildren(...tags);

    const range = $('#w-range');
    range.max = String(s.max);
    $('#w-quick').replaceChildren(
      ...QUICK.map(([label, f]) => el('button', { type: 'button', className: 'quick', dataset: { f }, onclick: () => setWager(Math.round(wagerMax * f)) }, label))
    );
    setWager(Math.round(s.max / 4));
    $('#w-lock').disabled = false;
    $('#w-hint').textContent =
      s.points === 'none'
        ? 'This one is just for fun: nothing is won or lost.'
        : s.score < s.max
          ? `You can bet up to ${s.max.toLocaleString()} even with fewer points. You can't drop below 0.`
          : 'Right answer: you win your bet. Wrong answer: you lose it.';
    showScreen('screen-wager');
    runTimer('w');
  }

  function setWager(v) {
    const n = Math.max(0, Math.min(wagerMax, Math.round(Number(v) || 0)));
    $('#w-range').value = String(n);
    $('#w-amount').textContent = n.toLocaleString();
    for (const b of $('#w-quick').children) b.classList.toggle('on', Math.round(wagerMax * Number(b.dataset.f)) === n);
  }
  $('#w-range').addEventListener('input', (e) => setWager(e.target.value));

  $('#w-lock').addEventListener('click', async () => {
    const btn = $('#w-lock');
    btn.disabled = true;
    navigator.vibrate?.(30);
    const res = await request(socket, 'player:wager', { amount: Number($('#w-range').value) });
    if (!res.ok) {
      toast(res.error);
      if (/connection|respond/i.test(res.error)) btn.disabled = false;
    }
  });

  // ---- A-D answers (and Split Decision's first step: pick a side)

  let splitPick = null; // { i, text } while choosing a side in Split Decision

  function renderQuestion(s) {
    startPhase(s);
    splitPick = null;
    $('#p-qcounter').textContent = counter(s);
    $('#p-qtext').textContent = s.question;
    const list = $('#p-answers');
    list.className = `p-answers count-${s.answers.length}`;
    list.replaceChildren(
      ...s.answers.map((text, i) =>
        RT.answerCard(i, text, 'button', {
          type: 'button',
          'aria-label': `${RT.LETTERS[i]}: ${text}`,
          onclick: () => (s.input === 'split' ? pickSide(i, text) : answer(i)),
        })
      )
    );
    showScreen('screen-question');
    runTimer('p');
  }

  function answer(i) {
    const grid = $('#p-answers');
    if (grid.classList.contains('locked')) return;
    grid.classList.add('locked');
    grid.children[i]?.classList.add('chosen');
    sendAnswer({ index: i }, () => {
      grid.classList.remove('locked');
      grid.children[i]?.classList.remove('chosen');
    });
  }

  // ---- Split Decision, step 2: what % of the room picked A?

  function pickSide(i, text) {
    navigator.vibrate?.(20);
    splitPick = { i, text };
    const a = current.answers[0];
    $('#g-counter').textContent = counter(current);
    $('#g-pick').textContent = text;
    $('#g-title').textContent = `What % of the room picked “${a}”?`;
    $('#g-lock').disabled = false;
    setGuess($('#g-range').value);
    showScreen('screen-guess');
    runTimer('g');
  }

  function setGuess(v) {
    const n = Math.max(0, Math.min(100, Math.round(Number(v))));
    $('#g-range').value = String(n);
    const [a, b] = current?.answers || ['A', 'B'];
    const sa = $('#g-a');
    const sb = $('#g-b');
    sa.style.flexGrow = String(Math.max(n, 0.001));
    sb.style.flexGrow = String(Math.max(100 - n, 0.001));
    sa.replaceChildren(el('strong', {}, `${n}%`), el('span', {}, a));
    sb.replaceChildren(el('strong', {}, `${100 - n}%`), el('span', {}, b));
  }
  $('#g-range').addEventListener('input', (e) => setGuess(e.target.value));

  $('#g-back').addEventListener('click', () => {
    splitPick = null;
    showScreen('screen-question');
    runTimer('p');
  });

  $('#g-lock').addEventListener('click', () => {
    if (!splitPick) return;
    const btn = $('#g-lock');
    btn.disabled = true;
    sendAnswer({ index: splitPick.i, guess: Number($('#g-range').value) }, () => (btn.disabled = false));
  });

  // ---- Sticker Shock: a number keypad

  let typed = '';
  const MAX_DIGITS = 10;
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  $('#n-keypad').replaceChildren(
    ...KEYS.map((k) =>
      el('button', { type: 'button', className: 'key' + (k === '⌫' ? ' back' : ''), 'aria-label': k === '⌫' ? 'Delete' : k, onclick: () => press(k) }, k)
    )
  );

  function renderNumber(s) {
    startPhase(s);
    typed = '';
    $('#n-counter').textContent = counter(s);
    $('#n-qtext').textContent = s.question;
    showNumber();
    showScreen('screen-number');
    runTimer('n');
  }

  function press(k) {
    if (k === '⌫') typed = typed.slice(0, -1);
    else if (k === '.') {
      if (!typed.includes('.')) typed = (typed || '0') + '.';
    } else {
      const [whole, dec] = typed.split('.');
      if (dec != null && dec.length >= 2) return; // cents at most
      if (typed.replace('.', '').length >= MAX_DIGITS) return;
      typed = whole === '0' && dec == null ? k : typed + k; // no leading zeros
    }
    navigator.vibrate?.(8);
    showNumber();
  }

  function showNumber() {
    const s = current || {};
    const unit = s.suffix ? (/^[a-z]/i.test(s.suffix) ? ' ' : '') + s.suffix : '';
    // Show what's typed with thousands separators, keeping a trailing "." while typing decimals.
    const [whole, dec] = typed.split('.');
    const shown = typed ? Number(whole || 0).toLocaleString() + (dec != null ? '.' + dec : '') : '0';
    $('#n-display').replaceChildren(
      s.prefix ? el('span', { className: 'unit' }, s.prefix) : '',
      el('span', { className: typed ? '' : 'placeholder' }, shown),
      unit ? el('span', { className: 'unit' }, unit) : ''
    );
    $('#n-lock').disabled = !typed || !Number.isFinite(Number(typed));
  }

  $('#n-lock').addEventListener('click', () => {
    const btn = $('#n-lock');
    if (btn.disabled) return;
    btn.disabled = true;
    sendAnswer({ value: Number(typed) }, () => (btn.disabled = false));
  });

  // A keyboard works too (handy on a laptop).
  document.addEventListener('keydown', (e) => {
    if ($('#screen-number').hidden || e.target.closest('input')) return;
    if (/^[0-9.]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') $('#n-lock').click();
    else return;
    e.preventDefault();
  });

  // ---- Locked in: show what was sent

  function renderAnswered(s) {
    const m = s.mine || {};
    $('#answered-title').textContent = m.kind === 'wager' ? 'Bet placed!' : 'Locked in!';
    let shape = [];
    if (m.kind === 'wager') {
      shape = [el('div', { className: 'num-display' }, (m.wager || 0).toLocaleString()), el('p', { className: 'muted' }, 'points on the line')];
    } else if (m.kind === 'number') {
      shape = [el('div', { className: 'num-display' }, formatValue(m.value, m.prefix, m.suffix))];
    } else if (m.index != null) {
      shape = [RT.answerCard(m.index, m.text)];
      if (m.kind === 'split') shape.push(el('p', { className: 'muted' }, `You guessed ${m.guess}% picked “${m.splitA}”`));
    }
    $('#answered-shape').replaceChildren(...shape);
    showScreen('screen-answered');
  }

  // ---- Result of a question

  function renderResult(s) {
    let icon;
    let title;
    let detail = '';
    let theme = s.correct ? 'good' : 'bad';

    if (!s.answered) {
      icon = '⏱';
      title = "Time's up!";
      if (s.mode === 'wager' && s.points < 0) detail = `You lost your bet of ${(-s.points).toLocaleString()}.`;
    } else if (s.input === 'split') {
      icon = s.correct ? '🎯' : '%';
      title = s.error < 0.5 ? 'Spot on!' : s.correct ? 'Closest guess!' : `Off by ${s.error}%`;
      theme = s.correct || s.error <= 10 ? 'good' : 'bad';
      detail = `${s.pct}% picked “${s.splitA}”. You guessed ${s.guess}%.`;
    } else if (s.input === 'number') {
      const actual = formatValue(s.actual, s.prefix, s.suffix);
      const mine = formatValue(s.value, s.prefix, s.suffix);
      if (s.winner) {
        icon = s.exact ? '🎯' : '✓';
        title = s.exact ? 'Perfect bid!' : 'Winning bid!';
      } else if (s.over) {
        icon = '✗';
        title = 'Over!';
      } else {
        icon = '↓';
        title = 'Under, but not closest';
        theme = null;
      }
      detail = `Actual: ${actual} · You said: ${mine}`;
    } else {
      icon = s.correct ? '✓' : '✗';
      if (s.mode === 'majority') title = s.correct ? 'With the table!' : 'Against the table';
      else title = s.correct ? 'Correct!' : 'Incorrect';
      if (s.mode === 'wager') {
        detail = !s.wager
          ? 'You bet nothing on this one.'
          : s.correct
            ? `You bet ${s.wager.toLocaleString()} and won.`
            : `You bet ${s.wager.toLocaleString()} and lost it.`;
      }
    }

    setResultTheme(theme);
    $('#result-icon').textContent = icon;
    $('#result-title').textContent = title;
    $('#result-points').textContent = signed(s.points);
    $('#result-detail').textContent = detail;
    $('#result-streak').textContent = s.streak >= 2 ? `🔥 Streak: ${s.streak}` : '';

    let rankText;
    if (s.rank === 1) rankText = `You're in 1st place! 🏆`;
    else if (s.behindBy === 0) rankText = `You're in ${ordinal(s.rank)} place, tied with ${s.behindName}`;
    else rankText = `You're in ${ordinal(s.rank)} place, ${s.behindBy.toLocaleString()} points behind ${s.behindName}`;
    $('#result-rank').textContent = rankText;
    if (theme === 'good') navigator.vibrate?.([40, 60, 40]);
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
