// One Game = one lobby with one host screen and many players.
// The server is authoritative: it owns the timers, the answers and the scores.
const crypto = require('crypto');
const { MAX_NUMBER } = require('./trivia');

const INTRO_MS = 4000; // "Get ready" screen before answers open
const HOST_GRACE_MS = 2 * 60 * 1000; // host can refresh/reconnect within this window
const LOBBY_DROP_MS = 60 * 1000; // disconnected players are removed from the lobby after this
const FINISHED_TTL_MS = 15 * 60 * 1000; // finished games are cleaned up after this
const MAX_STREAK_BONUS = 500;
const TABLE_MIN_SEATS = 8; // seats drawn around an empty table
const TABLE_GROW_BY = 4; // seats added each time the table fills up
const RECONNECT_GRACE_MS = 15 * 1000; // a question won't end early while a player is reconnecting

// Wager Wars
const START_BANK = 1000; // everyone starts with this many points to bet with
const WAGER_FLOOR = 500; // you can always bet up to this much, even with fewer points

// Split Decision: 1,000 for a perfect guess, 25 fewer per percentage point off, +250 for the closest.
const SPLIT_PER_POINT = 25;
const SPLIT_CLOSEST_BONUS = 250;

// Sticker Shock: the closest bid without going over wins 1,000 (1,500 if exact). Other bids under the
// price score up to 500, in proportion to how close they got. Bids over the price score nothing.
const BID_WIN = 1000;
const BID_EXACT_BONUS = 500;
const BID_UNDER_MAX = 500;

/** How players answer in each scoring mode (see games.js). */
const INPUT = { correct: 'choice', majority: 'choice', wager: 'choice', split: 'split', closest: 'number' };

const EPS = 1e-9;
const newToken = () => crypto.randomBytes(18).toString('base64url');
const multiplier = (q) => (q.points === 'double' ? 2 : q.points === 'none' ? 0 : 1);

class Game {
  constructor({ io, pin, set, gameId = 'trivia', gameName = 'Trivia', mode = 'correct', stat = 'correct', wagerTime = 15, joinUrl, qr, maxPlayers, onDispose }) {
    this.io = io;
    this.pin = pin;
    this.set = set;
    this.gameId = gameId;
    this.gameName = gameName;
    this.mode = mode; // 'correct' | 'majority' | 'wager' | 'split' | 'closest' — see games.js
    this.input = INPUT[mode] || 'choice'; // what the phones show: A-D buttons, A/B + a % slider, or a keypad
    this.stat = stat; // what correctCount means on the final screens, e.g. "correct"
    this.wagerTime = wagerTime; // seconds to place a bet (Wager Wars)
    this.lastReveal = null; // what the host screen shows after a question (mode-specific)
    this.joinUrl = joinUrl;
    this.qr = qr;
    this.maxPlayers = maxPlayers;
    this.onDispose = onDispose;

    this.hostToken = newToken();
    this.hostSocketId = null;
    this.hostGraceTimer = null;

    this.players = new Map(); // playerId -> player
    this.state = 'lobby'; // lobby | wager | intro | question | reveal | scoreboard | finished
    this.locked = false;
    this.qIndex = -1;
    this.timer = null;
    this.phaseEndsAt = 0;
    this.questionStartedAt = 0;
    this.lastActivity = Date.now();
    this.disposed = false;
  }

  get room() {
    return `game:${this.pin}`;
  }
  get question() {
    return this.set.questions[this.qIndex];
  }
  get total() {
    return this.set.questions.length;
  }
  get isLastQuestion() {
    return this.qIndex >= this.total - 1;
  }
  touch() {
    this.lastActivity = Date.now();
  }

  // ------------------------------------------------------------------ host

  attachHost(socket) {
    if (this.hostSocketId && this.hostSocketId !== socket.id) {
      // Another tab took over hosting; tell the old one.
      this.io.to(this.hostSocketId).emit('host:replaced');
    }
    this.hostSocketId = socket.id;
    socket.data.role = 'host';
    socket.data.pin = this.pin;
    clearTimeout(this.hostGraceTimer);
    this.hostGraceTimer = null;
    this.touch();
    this.sendHostState();
  }

  hostDisconnected(socketId) {
    if (socketId !== this.hostSocketId) return;
    this.hostSocketId = null;
    if (this.state === 'finished') return;
    this.hostGraceTimer = setTimeout(() => this.end('The host left the game.'), HOST_GRACE_MS);
  }

  isHost(socket) {
    return socket.id === this.hostSocketId;
  }

  toHost(event, payload) {
    if (this.hostSocketId) this.io.to(this.hostSocketId).emit(event, payload);
  }

  // --------------------------------------------------------------- players

  addPlayer(socket, rawName) {
    if (this.state === 'finished') throw new Error('This game has already finished.');
    if (this.locked) throw new Error('This game is locked by the host.');
    if (this.players.size >= this.maxPlayers) throw new Error('This game is full.');

    const name = String(rawName ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 16);
    if (!name) throw new Error('Please enter a nickname.');
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new Error('That nickname is taken. Try another one.');

    const player = {
      id: crypto.randomUUID(),
      token: newToken(),
      name,
      seat: this.freeSeat(), // the lowest empty seat, so leavers' seats get reused
      score: this.mode === 'wager' ? START_BANK : 0,
      streak: 0,
      correctCount: 0,
      lastPoints: 0,
      answer: null, // for the current question: { index?, guess?, value?, ms }
      wager: null, // Wager Wars: the bet on the current question
      lastResult: null,
      socketId: null,
      connected: false,
      disconnectedAt: 0,
      dropTimer: null,
    };
    this.players.set(player.id, player);
    this.attachPlayer(socket, player);
    return player;
  }

  findPlayerByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  attachPlayer(socket, player) {
    if (player.socketId && player.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(player.socketId);
      if (old) {
        old.emit('game:ended', { reason: 'You joined from another tab or device.' });
        old.leave(this.room);
        old.data = {};
      }
    }
    clearTimeout(player.dropTimer);
    player.dropTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.data.role = 'player';
    socket.data.pin = this.pin;
    socket.data.playerId = player.id;
    socket.join(this.room);
    this.touch();
    this.sendPlayerState(player);
    this.sendLobbyUpdate();
  }

  playerDisconnected(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player || player.socketId !== socketId) return;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    if (this.state === 'lobby') {
      player.dropTimer = setTimeout(() => {
        if (!player.connected && this.state === 'lobby') {
          this.players.delete(player.id);
          this.sendLobbyUpdate();
        }
      }, LOBBY_DROP_MS);
    }
    this.sendLobbyUpdate();
    this.checkAllIn();
  }

  kick(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    clearTimeout(player.dropTimer);
    this.players.delete(playerId);
    if (player.socketId) {
      const s = this.io.sockets.sockets.get(player.socketId);
      if (s) {
        s.emit('player:kicked');
        s.leave(this.room);
        s.data = {};
      }
    }
    this.sendLobbyUpdate();
    this.checkAllIn();
  }

  toPlayer(player, event, payload) {
    if (player.connected && player.socketId) this.io.to(player.socketId).emit(event, payload);
  }

  /** Players in seat order. */
  seated() {
    return [...this.players.values()].sort((a, b) => a.seat - b.seat);
  }

  /** The lowest seat number nobody is sitting in, so seats freed by leavers get reused. */
  freeSeat() {
    const taken = new Set([...this.players.values()].map((p) => p.seat));
    let seat = 1;
    while (taken.has(seat)) seat++;
    return seat;
  }

  /**
   * How many seats to draw around the table: 8 to start, growing 4 at a time so there's always
   * at least one free seat beyond the highest one taken.
   */
  tableSize() {
    const highest = Math.max(0, ...[...this.players.values()].map((p) => p.seat));
    return Math.max(TABLE_MIN_SEATS, Math.ceil((highest + 1) / TABLE_GROW_BY) * TABLE_GROW_BY);
  }

  publicPlayers() {
    return this.seated().map((p) => ({ id: p.id, name: p.name, seat: p.seat, connected: p.connected }));
  }

  /** Has this player done what the current phase asks: placed a bet (wager) or answered (question)? */
  isIn(p) {
    return this.state === 'wager' ? p.wager != null : !!p.answer;
  }

  /** Seats around the table for the host screen: who is in (wager/question) or what they chose (reveal). */
  seatList(reveal = false) {
    return this.seated().map((p) =>
      reveal
        ? { id: p.id, seat: p.seat, name: p.name, choice: p.answer?.index ?? null }
        : { id: p.id, seat: p.seat, name: p.name, answered: this.isIn(p) }
    );
  }

  sendLobbyUpdate() {
    this.toHost('host:players', { players: this.publicPlayers(), tableSize: this.tableSize() });
  }

  /** Live "3 of 8 in" updates for the host while bets or answers come in. */
  sendProgress() {
    this.toHost('host:answers', {
      phase: this.state,
      answered: this.answeredCount(),
      playerCount: this.players.size,
      seats: this.seatList(),
      tableSize: this.tableSize(),
    });
  }

  leaderboard() {
    return [...this.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------- game flow

  setLocked(locked) {
    this.locked = !!locked;
    this.sendHostState();
  }

  start() {
    if (this.state !== 'lobby') throw new Error('The game has already started.');
    if (this.players.size === 0) throw new Error('Wait for at least one player to join.');
    this.nextQuestion();
  }

  next() {
    if (this.state === 'reveal') {
      if (this.isLastQuestion) this.finish();
      else this.showScoreboard();
    } else if (this.state === 'scoreboard') {
      this.nextQuestion();
    } else if (this.state === 'wager') {
      this.startIntro(); // "Skip" — close the bets now
    } else if (this.state === 'question') {
      this.reveal(); // "Skip" — end the question now
    }
  }

  nextQuestion() {
    clearTimeout(this.timer);
    this.qIndex += 1;
    for (const p of this.players.values()) {
      p.answer = null;
      p.wager = null;
    }
    if (this.mode === 'wager') this.openWagers();
    else this.startIntro();
  }

  /** Wager Wars: show the next question's category and let everyone bet before it's asked. */
  openWagers() {
    clearTimeout(this.timer);
    this.state = 'wager';
    this.phaseEndsAt = Date.now() + this.wagerTime * 1000;
    this.touch();
    this.broadcastState();
    this.timer = setTimeout(() => this.startIntro(), this.wagerTime * 1000 + 250);
  }

  /** The most a player may bet: their score, or WAGER_FLOOR if they have less than that. */
  maxWager(p) {
    return Math.max(p.score, WAGER_FLOOR);
  }

  submitWager(playerId, amount) {
    if (this.state !== 'wager') throw new Error('Too late — bets are closed.');
    const player = this.players.get(playerId);
    if (!player) throw new Error('You are not in this game.');
    if (player.wager != null) throw new Error('You already placed your bet.');
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) throw new Error('Invalid bet.');
    player.wager = Math.min(this.maxWager(player), Math.max(0, n));
    this.touch();
    this.sendPlayerState(player);
    this.sendProgress();
    this.checkAllIn();
  }

  startIntro() {
    clearTimeout(this.timer);
    this.state = 'intro';
    this.phaseEndsAt = Date.now() + INTRO_MS;
    this.touch();
    this.broadcastState();
    this.timer = setTimeout(() => this.openAnswers(), INTRO_MS);
  }

  openAnswers() {
    clearTimeout(this.timer);
    const q = this.question;
    this.state = 'question';
    this.questionStartedAt = Date.now();
    this.phaseEndsAt = this.questionStartedAt + q.time * 1000;
    this.broadcastState();
    this.timer = setTimeout(() => this.reveal(), q.time * 1000 + 250); // small grace for latency
  }

  /** Checks a submitted answer against what this game's phones can send. */
  parseAnswer(raw) {
    const q = this.question;
    if (this.input === 'number') {
      const v = Number(typeof raw.value === 'string' ? raw.value.trim() : raw.value);
      if (raw.value == null || raw.value === '' || !Number.isFinite(v) || v < 0 || v > MAX_NUMBER) {
        throw new Error('Type a number first.');
      }
      return { value: Math.round(v * 10000) / 10000 };
    }
    const i = Number(raw.index);
    if (!Number.isInteger(i) || i < 0 || i >= q.answers.length) throw new Error('Invalid answer.');
    if (this.input === 'split') {
      const g = Number(raw.guess);
      if (raw.guess == null || !Number.isFinite(g) || g < 0 || g > 100) throw new Error('Guess a percentage from 0 to 100.');
      return { index: i, guess: Math.round(g) };
    }
    return { index: i };
  }

  submitAnswer(playerId, raw = {}) {
    if (this.state !== 'question') throw new Error('Too late — answers are closed.');
    const player = this.players.get(playerId);
    if (!player) throw new Error('You are not in this game.');
    if (player.answer) throw new Error('You already answered.');

    player.answer = { ...this.parseAnswer(raw), ms: Date.now() - this.questionStartedAt };
    this.touch();
    this.sendPlayerState(player);
    this.sendProgress();
    this.checkAllIn();
  }

  answeredCount() {
    let n = 0;
    for (const p of this.players.values()) if (this.isIn(p)) n++;
    return n;
  }

  /** Moves on early once everyone has bet (wager) or answered (question). */
  checkAllIn() {
    if (this.state !== 'question' && this.state !== 'wager') return;
    // Players who dropped out recently (e.g. phone screen locked) still get waited for.
    const now = Date.now();
    const active = [...this.players.values()].filter(
      (p) => p.connected || this.isIn(p) || now - p.disconnectedAt < RECONNECT_GRACE_MS
    );
    if (!active.length || !active.every((p) => this.isIn(p))) return;
    if (this.state === 'wager') this.startIntro();
    else this.reveal();
  }

  // ------------------------------------------------------------- scoring

  /**
   * A-D questions: Trivia, Majority Rules and Wager Wars.
   * Returns per-player results and what the host screen shows.
   */
  scoreChoice(q) {
    const counts = new Array(q.answers.length).fill(0);
    for (const p of this.players.values()) if (p.answer) counts[p.answer.index] += 1;

    // Which answers score: the right ones, or the most popular ones (Majority Rules; ties all count).
    let winning = q.correct;
    if (this.mode === 'majority') {
      const top = Math.max(0, ...counts);
      winning = top === 0 ? [] : counts.flatMap((c, i) => (c === top ? [i] : []));
    }

    const limitMs = q.time * 1000;
    const results = new Map();
    for (const p of this.players.values()) {
      const correct = Boolean(p.answer && winning.includes(p.answer.index));
      let points = 0;
      if (this.mode === 'wager') {
        // Win the bet (twice over on a double-points question), or lose it. Unanswered loses too.
        const wager = p.wager ?? 0;
        if (q.points !== 'none') points = correct ? wager * multiplier(q) : -Math.min(wager, p.score);
        results.set(p, { correct, points, wager });
      } else {
        // Faster answers earn more: 1000 points instantly, down to 500 at the buzzer.
        if (correct) points = Math.round(1000 * (1 - Math.min(1, p.answer.ms / limitMs) / 2)) * multiplier(q);
        results.set(p, { correct, points, streakBonus: correct && q.points !== 'none' });
      }
    }

    const reveal = {
      answers: q.answers,
      correct: winning,
      counts,
      answered: counts.reduce((a, b) => a + b, 0),
      correctCount: winning.reduce((sum, i) => sum + (counts[i] || 0), 0),
    };
    if (this.mode === 'wager') {
      // The biggest swing each way, for a line on the host screen.
      const swings = [...results].map(([p, r]) => ({ name: p.name, seat: p.seat, points: r.points }));
      const best = swings.reduce((a, b) => (b.points > (a?.points ?? 0) ? b : a), null);
      const worst = swings.reduce((a, b) => (b.points < (a?.points ?? 0) ? b : a), null);
      reveal.bets = { biggestWin: best, biggestLoss: worst };
    }
    return { results, reveal };
  }

  /** Split Decision: everyone picked A or B and guessed what % of the room picked A. */
  scoreSplit(q) {
    const counts = [0, 0];
    const voters = [...this.players.values()].filter((p) => p.answer);
    for (const p of voters) counts[p.answer.index] += 1;
    const pct = voters.length ? (100 * counts[0]) / voters.length : null;

    const results = new Map();
    const guesses = [];
    if (pct != null) {
      const best = Math.min(...voters.map((p) => Math.abs(p.answer.guess - pct)));
      for (const p of voters) {
        const error = Math.abs(p.answer.guess - pct);
        const closest = error - best < EPS;
        const points =
          Math.round(Math.max(0, 1000 - SPLIT_PER_POINT * error) + (closest ? SPLIT_CLOSEST_BONUS : 0)) * multiplier(q);
        const err = Math.round(error * 10) / 10;
        results.set(p, {
          correct: closest,
          points,
          choice: p.answer.index,
          guess: p.answer.guess,
          pct: Math.round(pct),
          error: err,
          splitA: q.answers[0],
        });
        guesses.push({ seat: p.seat, name: p.name, guess: p.answer.guess, error: err, points, closest });
      }
      guesses.sort((a, b) => a.error - b.error || a.name.localeCompare(b.name));
    }
    return {
      results,
      reveal: { answers: q.answers, counts, pct: pct == null ? null : Math.round(pct * 10) / 10, guesses, answered: voters.length },
    };
  }

  /** Sticker Shock: closest without going over. */
  scoreClosest(q) {
    const actual = q.answer;
    const bidders = [...this.players.values()].filter((p) => p.answer);
    const under = bidders.map((p) => p.answer.value).filter((v) => v <= actual + EPS);
    const top = under.length ? Math.max(...under) : null;

    const results = new Map();
    const guesses = [];
    for (const p of bidders) {
      const value = p.answer.value;
      const over = value > actual + EPS;
      const winner = !over && Math.abs(value - top) < EPS;
      const exact = winner && Math.abs(value - actual) < EPS;
      let points = 0;
      if (winner) points = BID_WIN + (exact ? BID_EXACT_BONUS : 0);
      else if (!over && actual > 0) points = Math.round((BID_UNDER_MAX * value) / actual);
      points *= multiplier(q);
      results.set(p, { correct: winner, points, value, over, winner, exact, actual, prefix: q.prefix, suffix: q.suffix });
      guesses.push({ seat: p.seat, name: p.name, value, over, winner, exact, points });
    }
    guesses.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    return {
      results,
      reveal: {
        answer: actual,
        prefix: q.prefix,
        suffix: q.suffix,
        guesses,
        answered: bidders.length,
        winners: guesses.filter((g) => g.winner).length,
      },
    };
  }

  reveal() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    const q = this.question;
    const scorer = { split: 'scoreSplit', number: 'scoreClosest' }[this.input] || 'scoreChoice';
    const { results, reveal } = this[scorer](q);

    for (const p of this.players.values()) {
      const r = results.get(p) || { correct: false, points: 0 };
      if (r.correct) {
        p.streak += 1;
        p.correctCount += 1;
      } else {
        p.streak = 0;
      }
      let points = r.points;
      if (r.streakBonus) points += Math.min((p.streak - 1) * 100, MAX_STREAK_BONUS);
      const before = p.score;
      p.score = Math.max(0, p.score + points);
      points = p.score - before; // a lost bet can't take a score below 0
      p.lastPoints = points;
      const { streakBonus, ...extra } = r;
      p.lastResult = { ...extra, answered: !!p.answer, correct: r.correct, points, streak: p.streak, mode: this.mode, input: this.input };
    }

    // Rank before this question, so the standings can show who moved up or down.
    [...this.players.values()]
      .sort((a, b) => b.score - b.lastPoints - (a.score - a.lastPoints) || a.name.localeCompare(b.name))
      .forEach((p, i) => (p.prevRank = i + 1));

    const board = this.leaderboard();
    board.forEach((p, i) => {
      const ahead = board[i - 1];
      Object.assign(p.lastResult, {
        rank: i + 1,
        playerCount: board.length,
        behindName: ahead ? ahead.name : null,
        behindBy: ahead ? ahead.score - p.score : 0,
      });
    });

    this.lastReveal = reveal;
    this.state = 'reveal';
    this.touch();
    this.broadcastState();
  }

  showScoreboard() {
    this.state = 'scoreboard';
    this.touch();
    this.broadcastState();
  }

  finish() {
    clearTimeout(this.timer);
    this.state = 'finished';
    this.touch();
    this.broadcastState();
    clearTimeout(this.hostGraceTimer);
    this.timer = setTimeout(() => this.dispose(), FINISHED_TTL_MS);
  }

  /** Ends the game for everyone with a message. */
  end(reason) {
    if (this.disposed) return;
    this.io.to(this.room).emit('game:ended', { reason });
    this.toHost('game:ended', { reason });
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.hostGraceTimer);
    for (const p of this.players.values()) clearTimeout(p.dropTimer);
    this.io.in(this.room).socketsLeave(this.room);
    this.onDispose(this.pin);
  }

  // ------------------------------------------------- state -> screens

  broadcastState() {
    this.sendHostState();
    for (const p of this.players.values()) this.sendPlayerState(p);
  }

  timeLeft() {
    return Math.max(0, this.phaseEndsAt - Date.now());
  }

  sendHostState() {
    const q = this.question;
    const common = {
      pin: this.pin,
      title: this.set.title,
      game: this.gameId,
      gameName: this.gameName,
      mode: this.mode,
      input: this.input,
      stat: this.stat,
      index: this.qIndex,
      total: this.total,
    };
    let payload;
    switch (this.state) {
      case 'lobby':
        payload = {
          phase: 'lobby',
          ...common,
          joinUrl: this.joinUrl,
          qr: this.qr,
          locked: this.locked,
          players: this.publicPlayers(),
          tableSize: this.tableSize(),
        };
        break;
      case 'wager':
        payload = {
          phase: 'wager',
          ...common,
          category: q.category || null,
          difficulty: q.difficulty || null,
          points: q.points,
          time: this.wagerTime,
          timeLeft: this.timeLeft(),
          answered: this.answeredCount(),
          playerCount: this.players.size,
          seats: this.seatList(),
          tableSize: this.tableSize(),
        };
        break;
      case 'intro':
        payload = { phase: 'intro', ...common, question: q.question, image: q.image, points: q.points, timeLeft: this.timeLeft(), introMs: INTRO_MS };
        break;
      case 'question':
        payload = {
          phase: 'question',
          ...common,
          question: q.question,
          credit: q.credit || null, // e.g. "Open Trivia DB · CC BY-SA 4.0" for online questions
          image: q.image,
          answers: q.answers,
          prefix: q.prefix || '',
          suffix: q.suffix || '',
          points: q.points,
          time: q.time,
          timeLeft: this.timeLeft(),
          answered: this.answeredCount(),
          playerCount: this.players.size,
          seats: this.seatList(),
          tableSize: this.tableSize(),
        };
        break;
      case 'reveal':
        payload = {
          phase: 'reveal',
          ...common,
          question: q.question,
          credit: q.credit || null, // e.g. "Open Trivia DB · CC BY-SA 4.0" for online questions
          note: q.note || null,
          image: q.image,
          playerCount: this.players.size,
          isLast: this.isLastQuestion,
          seats: this.seatList(true),
          tableSize: this.tableSize(),
          ...this.lastReveal,
        };
        break;
      case 'scoreboard': {
        const board = this.leaderboard();
        payload = {
          phase: 'scoreboard',
          ...common,
          maxScore: board[0]?.score || 0,
          top: board.slice(0, 5).map((p, i) => ({
            name: p.name,
            seat: p.seat,
            score: p.score,
            delta: p.lastPoints,
            streak: p.streak,
            rank: i + 1,
            prevRank: p.prevRank || i + 1,
          })),
        };
        break;
      }
      case 'finished':
        payload = {
          phase: 'finished',
          ...common,
          podium: this.leaderboard().slice(0, 5).map((p) => ({ name: p.name, seat: p.seat, score: p.score, correct: p.correctCount })),
          playerCount: this.players.size,
        };
        break;
    }
    this.toHost('host:state', payload);
  }

  playerBase(p) {
    return {
      pin: this.pin,
      name: p.name,
      seat: p.seat,
      score: p.score,
      index: this.qIndex,
      total: this.total,
      mode: this.mode,
      input: this.input,
      stat: this.stat,
      gameName: this.gameName,
    };
  }

  /** What this player sent this phase, so their phone can show it (even after a refresh). */
  mine(p) {
    if (this.state === 'wager') return { kind: 'wager', wager: p.wager };
    const a = p.answer;
    if (!a) return null;
    const q = this.question;
    return {
      kind: this.input,
      index: a.index ?? null,
      text: a.index != null ? q.answers[a.index] : null,
      guess: a.guess ?? null,
      splitA: this.input === 'split' ? q.answers[0] : null,
      value: a.value ?? null,
      prefix: q.prefix || '',
      suffix: q.suffix || '',
    };
  }

  sendPlayerState(p) {
    const base = this.playerBase(p);
    const q = this.question;
    let payload;
    switch (this.state) {
      case 'lobby':
        payload = { phase: 'lobby', ...base, title: this.set.title };
        break;
      case 'wager':
        payload =
          p.wager != null
            ? { phase: 'answered', ...base, mine: this.mine(p) }
            : {
                phase: 'wager',
                ...base,
                category: q.category || null,
                difficulty: q.difficulty || null,
                points: q.points,
                max: this.maxWager(p),
                time: this.wagerTime,
                timeLeft: this.timeLeft(),
              };
        break;
      case 'intro':
        payload = { phase: 'intro', ...base, timeLeft: this.timeLeft(), points: q.points, wager: this.mode === 'wager' ? p.wager ?? 0 : null };
        break;
      case 'question':
        payload = p.answer
          ? { phase: 'answered', ...base, mine: this.mine(p) }
          : {
              phase: 'question',
              ...base,
              answers: q.answers,
              question: q.question,
              prefix: q.prefix || '',
              suffix: q.suffix || '',
              wager: this.mode === 'wager' ? p.wager ?? 0 : null,
              time: q.time,
              timeLeft: this.timeLeft(),
            };
        break;
      case 'reveal':
      case 'scoreboard':
        payload = p.lastResult ? { phase: 'result', ...base, ...p.lastResult } : { phase: 'wait', ...base };
        break;
      case 'finished': {
        const board = this.leaderboard();
        payload = {
          phase: 'finished',
          ...base,
          rank: board.indexOf(p) + 1,
          playerCount: board.length,
          correctCount: p.correctCount,
        };
        break;
      }
    }
    this.toPlayer(p, 'player:state', payload);
  }
}

module.exports = { Game, newToken };
