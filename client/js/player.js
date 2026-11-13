// Player screen: join with a PIN + nickname, then use the phone as a controller:
// Wager Wars: a bet slider before each question, then A-D answer buttons.
// Only One: type as many answers as you can for the category on the big screen.
// Split Decision: pick a side, then guess what percent of the room picked the first answer.
(() => {
  const { $, el, showScreen, request, countdown, toast, watchConnection, storage, ordinal, signed } = window.RT;
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
        $('#lobby-title').textContent = s.choosing ? 'Next game coming up' : `${s.gameName} · ${s.title}`;
        $('#lobby-msg').textContent = s.choosing
          ? 'The host is picking the next game. Scores start fresh.'
          : 'Find your seat at the table on the big screen. The game starts soon.';
        return showScreen('screen-lobby');

      case 'wager':
        return renderWager(s);

      case 'intro': {
        $('#intro-counter').textContent = `${s.gameName} · ${s.unit} ${s.index + 1} of ${s.total}`;
        $('#intro-hint').textContent =
          s.kind === 'onlyone' ? 'Get ready to type as many as you can…' : s.kind === 'split' ? 'Get ready to pick a side…' : 'Answers coming up…';
        $('#intro-category').textContent = s.category || '';
        $('#intro-question').textContent = s.question || 'Get ready!';
        $('#intro-double').hidden = s.points !== 'double';
        const wager = $('#intro-wager');
        wager.hidden = s.wager == null;
        wager.textContent = s.wager ? `Your bet: ${s.wager.toLocaleString()}` : 'No bet on this one';
        showScreen('screen-intro');
        RT.drainBar($('#intro-progress'), s.timeLeft, 4000);
        return;
      }

      case 'question':
        return renderQuestion(s);

      case 'answered':
        return renderAnswered(s);

      case 'guess':
        return renderGuess(s);

      case 'list':
        return renderList(s);

      case 'checking':
        return renderChecking(s);

      case 'wait':
        $('#wait-msg').textContent =
          s.until === 'game' ? "This game just ended. You'll be playing from the next one." : "You'll be playing from the next question.";
        return showScreen('screen-wait');

      case 'result':
        return renderResult(s);

      case 'finished':
        $('#final-rank').textContent = ordinal(s.rank);
        $('#final-detail').textContent =
          `out of ${s.playerCount} player${s.playerCount === 1 ? '' : 's'} · ${s.score.toLocaleString()} points · ` +
          `${s.stat}` +
          (s.rank === 1 ? ' 🏆' : s.rank <= 3 ? ' 🎉' : '');
        // Stay at the table: if the host plays again, this phone moves to the lobby by itself.
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

  // ---- Bet on the category before the question is shown

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

  // ---- A-D answers

  function renderQuestion(s) {
    startPhase(s);
    $('#p-qcounter').textContent = counter(s);
    $('#p-qtext').textContent = s.question;
    const list = $('#p-answers');
    list.className = `p-answers count-${s.answers.length}`;
    list.replaceChildren(
      ...s.answers.map((text, i) =>
        RT.answerCard(i, text, 'button', {
          type: 'button',
          'aria-label': `${RT.LETTERS[i]}: ${text}`,
          onclick: () => answer(i),
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

  // ---- Split Decision: guess what percent of the room picked the first answer

  function renderGuess(s) {
    startPhase(s);
    const [a, b] = s.answers;
    $('#g-counter').textContent = `${s.unit} ${s.index + 1} of ${s.total}`;
    $('#g-question').textContent = s.question;
    $('#g-ask').replaceChildren('What percent of the room picked ', el('strong', {}, a), '?');
    $('#g-a').textContent = a;
    $('#g-b').textContent = b;
    $('#g-hint').textContent = s.voted == null ? "You didn't pick a side, but you can still guess." : `You picked ${s.answers[s.voted]}.`;
    $('#g-lock').disabled = false;
    setGuess(50);
    showScreen('screen-guess');
    runTimer('g');
  }

  function setGuess(v) {
    const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const [a, b] = current?.answers || ['', ''];
    $('#g-range').value = String(n);
    $('#g-amount').textContent = `${n}%`;
    $('#g-amount').setAttribute('aria-label', `${n}% ${a}, ${100 - n}% ${b}`);
    $('#g-bar').style.setProperty('--a', `${n}%`);
  }
  $('#g-range').addEventListener('input', (e) => setGuess(e.target.value));
  for (const btn of $('#g-quick').children) {
    btn.addEventListener('click', () => setGuess(Number($('#g-range').value) + Number(btn.dataset.step)));
  }

  $('#g-lock').addEventListener('click', async () => {
    const btn = $('#g-lock');
    btn.disabled = true;
    navigator.vibrate?.(30);
    const res = await request(socket, 'player:guess', { value: Number($('#g-range').value) });
    if (!res.ok) {
      toast(res.error);
      if (/connection|respond/i.test(res.error)) btn.disabled = false;
    }
  });

  // ---- Only One: type answers, see how they did

  let myList = [];
  const MARK = { unique: '★', shared: '=', rejected: '✕', repeat: '·' };

  function renderList(s) {
    startPhase(s);
    myList = s.list || [];
    $('#l-counter').textContent = `${s.unit} ${s.index + 1} of ${s.total}`;
    $('#l-prompt').textContent = s.question;
    $('#l-done-box').hidden = !s.done;
    $('#l-form').hidden = s.done;
    $('#l-done').textContent = s.done ? 'Keep going' : "I'm done";
    showList();
    showScreen('screen-list');
    runTimer('l');
    if (!s.done && !/iPhone|iPad|Android/.test(navigator.userAgent)) $('#l-input').focus({ preventScroll: true });
  }

  function showList() {
    const n = myList.length;
    $('#l-count').textContent = n ? `${n} answer${n === 1 ? '' : 's'}` : 'Answers only your table writes score 100 each.';
    $('#l-list').replaceChildren(
      ...[...myList].reverse().map((a) =>
        el(
          'li',
          {},
          el('span', {}, a.text),
          current?.done
            ? null
            : el('button', { type: 'button', className: 'l-x', 'aria-label': `Remove ${a.text}`, onclick: () => removeAnswer(a.id) }, '✕')
        )
      )
    );
  }

  $('#l-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#l-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.focus({ preventScroll: true });
    const res = await request(socket, 'player:oo-add', { text });
    if (!res.ok) {
      toast(res.error);
      if (/connection|respond/i.test(res.error)) input.value = text;
      return;
    }
    navigator.vibrate?.(10);
    myList = res.list;
    showList();
  });

  async function removeAnswer(id) {
    const res = await request(socket, 'player:oo-remove', { id });
    if (!res.ok) return toast(res.error);
    myList = res.list;
    showList();
  }

  $('#l-done').addEventListener('click', async () => {
    const res = await request(socket, 'player:oo-done', { done: !current?.done });
    if (!res.ok) toast(res.error);
  });

  /** One of your answers with how it did: ★ unique, = shared (with whom), ✕ rejected. */
  function markRow(m) {
    const note = m.status === 'shared' && m.with?.length ? `also ${m.with.join(', ')}` : m.status === 'repeat' ? 'same as another of yours' : '';
    return el(
      'li',
      { className: m.status || '' },
      el('span', { className: 'mark', 'aria-hidden': 'true' }, MARK[m.status] || '…'),
      el('span', {}, m.text),
      note ? el('small', {}, note) : null
    );
  }

  function renderChecking(s) {
    const mine = s.mine || [];
    const grouped = mine.some((m) => m.status);
    $('#c-prompt').textContent = s.question;
    $('#c-title').textContent = grouped ? 'The host is checking answers' : 'Grading answers…';
    $('#c-spinner').hidden = grouped;
    $('#c-list').replaceChildren(...mine.map(markRow));
    $('#c-note').textContent = mine.length ? (grouped ? '★ only you · = another table too · ✕ rejected' : '') : 'You didn’t write anything this round.';
    showScreen('screen-checking');
  }

  // ---- Locked in: show what was sent

  function renderAnswered(s) {
    const m = s.mine || {};
    $('#answered-title').textContent = m.kind === 'wager' ? 'Bet placed!' : 'Locked in!';
    let shape = [];
    if (m.kind === 'guess') {
      shape = [el('div', { className: 'num-display' }, `${m.guess}%`), el('p', { className: 'muted' }, `of the room picked ${m.answers[0]}`)];
    } else if (m.kind === 'wager') {
      shape = [el('div', { className: 'num-display' }, (m.wager || 0).toLocaleString()), el('p', { className: 'muted' }, 'points on the line')];
    } else if (m.index != null) {
      shape = [RT.answerCard(m.index, m.text)];
      if (m.wager) shape.push(el('p', { className: 'muted' }, `${m.wager.toLocaleString()} points on the line`));
    }
    $('#answered-shape').replaceChildren(...shape);
    showScreen('screen-answered');
  }

  // ---- Result of a question

  function renderResult(s) {
    let icon;
    let title;
    let detail;
    $('#result-list').replaceChildren();
    if (s.kind === 'onlyone') {
      icon = s.unique ? '★' : '✗';
      title = s.unique ? `${s.unique} unique answer${s.unique === 1 ? '' : 's'}!` : s.answered ? 'Nothing unique this time' : "Time's up!";
      detail = [s.shared && `${s.shared} shared`, s.rejected && `${s.rejected} rejected`].filter(Boolean).join(' · ');
      $('#result-list').replaceChildren(...(s.mine || []).map(markRow));
    } else if (s.kind === 'split') {
      const [a] = s.answers;
      if (s.noVotes) {
        icon = '–';
        title = 'Nobody picked a side';
        detail = 'No points this round.';
      } else if (!s.answered) {
        icon = '⏱';
        title = "Time's up!";
        detail = 'You didn’t lock in a guess.';
      } else {
        icon = s.closest ? '🎯' : s.off <= 10 ? '≈' : '✗';
        title = s.closest ? 'Closest guess!' : !s.off ? 'Spot on!' : s.off <= 10 ? `So close! ${s.off}% off` : `${s.off}% off`;
        detail = `You guessed ${s.guess}% ${a}. The room: ${s.actual}% ${a}.` + (s.bonus ? ` Includes the +${s.bonus} bonus.` : '');
      }
    } else if (!s.answered) {
      icon = '⏱';
      title = "Time's up!";
      detail = s.points < 0 ? `You lost your bet of ${(-s.points).toLocaleString()}.` : '';
    } else {
      icon = s.correct ? '✓' : '✗';
      title = s.correct ? 'Correct!' : 'Incorrect';
      detail = !s.wager
        ? 'You bet nothing on this one.'
        : s.correct
          ? `You bet ${s.wager.toLocaleString()} and won.`
          : `You bet ${s.wager.toLocaleString()} and lost it.`;
    }
    const theme = s.correct ? 'good' : 'bad';

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
  $('#again-btn').addEventListener('click', async () => {
    await request(socket, 'player:leave');
    joinFresh();
  });
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
