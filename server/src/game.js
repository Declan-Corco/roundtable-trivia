// One Game = one lobby with one host screen and many players.
// The server is authoritative: it owns the timers, the bets, the answers and the scores.
//
// Each question runs: bet (the category is shown, everyone bets some of their points)
// → get ready → answer A-D → reveal (right answers win their bet, wrong ones lose it) → standings.
const crypto = require('crypto');

const INTRO_MS = 4000; // "Get ready" screen before answers open
const HOST_GRACE_MS = 2 * 60 * 1000; // host can refresh/reconnect within this window
const LOBBY_DROP_MS = 60 * 1000; // disconnected players are removed from the lobby after this
const FINISHED_TTL_MS = 15 * 60 * 1000; // finished games are cleaned up after this
const TABLE_MIN_SEATS = 8; // seats drawn around an empty table
const TABLE_GROW_BY = 4; // seats added each time the table fills up
const RECONNECT_GRACE_MS = 15 * 1000; // a phase won't end early while a player is reconnecting

const START_BANK = 1000; // everyone starts with this many points to bet with
const WAGER_FLOOR = 500; // you can always bet up to this much, even with fewer points

const newToken = () => crypto.randomBytes(18).toString('base64url');
/** What a right answer pays per point bet: double-points questions pay 2x, practice questions 0. */
const multiplier = (q) => (q.points === 'double' ? 2 : q.points === 'none' ? 0 : 1);

class Game {
  constructor({ io, pin, set, gameName = 'Trivia', wagerTime = 15, joinUrl, qr, maxPlayers, onDispose }) {
    this.io = io;
    this.pin = pin;
    this.set = set;
    this.gameName = gameName;
    this.wagerTime = wagerTime; // seconds to place a bet
    this.lastReveal = null; // what the host screen shows after a question
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
      score: START_BANK,
      streak: 0,
      correctCount: 0,
      lastPoints: 0,
      answer: null, // for the current question: { index, ms }
      wager: null, // the bet on the current question
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
      this.startIntro(); // "Close bets" — anyone who hasn't bet is betting nothing
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
    this.openWagers();
  }

  /** Shows the next question's category and lets everyone bet before it's asked. */
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

  submitAnswer(playerId, index) {
    if (this.state !== 'question') throw new Error('Too late — answers are closed.');
    const player = this.players.get(playerId);
    if (!player) throw new Error('You are not in this game.');
    if (player.answer) throw new Error('You already answered.');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.question.answers.length) throw new Error('Invalid answer.');

    player.answer = { index: i, ms: Date.now() - this.questionStartedAt };
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

  /** Right answers win their bet (twice over on a double-points question); wrong or no answer loses it. */
  reveal() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    const q = this.question;

    const counts = new Array(q.answers.length).fill(0);
    for (const p of this.players.values()) if (p.answer) counts[p.answer.index] += 1;

    for (const p of this.players.values()) {
      const correct = Boolean(p.answer && q.correct.includes(p.answer.index));
      const wager = p.wager ?? 0;
      let points = 0;
      if (q.points !== 'none') points = correct ? wager * multiplier(q) : -Math.min(wager, p.score);
      if (correct) {
        p.streak += 1;
        p.correctCount += 1;
      } else {
        p.streak = 0;
      }
      p.score += points;
      p.lastPoints = points;
      p.lastResult = { answered: !!p.answer, correct, wager, points, streak: p.streak };
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

    // The biggest swing each way, for a line on the host screen.
    const swings = this.seated().map((p) => ({ name: p.name, seat: p.seat, points: p.lastPoints }));
    const biggestWin = swings.reduce((a, b) => (b.points > (a?.points ?? 0) ? b : a), null);
    const biggestLoss = swings.reduce((a, b) => (b.points < (a?.points ?? 0) ? b : a), null);

    this.lastReveal = {
      answers: q.answers,
      correct: q.correct,
      counts,
      answered: counts.reduce((a, b) => a + b, 0),
      correctCount: q.correct.reduce((sum, i) => sum + (counts[i] || 0), 0),
      bets: { biggestWin, biggestLoss },
    };
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
      gameName: this.gameName,
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
          credit: q.credit || null,
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
      gameName: this.gameName,
    };
  }

  /** What this player sent this phase, so their phone can show it (even after a refresh). */
  mine(p) {
    if (this.state === 'wager') return { kind: 'wager', wager: p.wager };
    if (!p.answer) return null;
    return { kind: 'answer', index: p.answer.index, text: this.question.answers[p.answer.index], wager: p.wager ?? 0 };
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
        payload = { phase: 'intro', ...base, timeLeft: this.timeLeft(), points: q.points, wager: p.wager ?? 0 };
        break;
      case 'question':
        payload = p.answer
          ? { phase: 'answered', ...base, mine: this.mine(p) }
          : {
              phase: 'question',
              ...base,
              answers: q.answers,
              question: q.question,
              wager: p.wager ?? 0,
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
