// One Game = one lobby with one host screen and many players.
// The server is authoritative: it owns the timers, the answers and the scores.
const crypto = require('crypto');

const INTRO_MS = 4000; // "Get ready" screen before answers open
const HOST_GRACE_MS = 2 * 60 * 1000; // host can refresh/reconnect within this window
const LOBBY_DROP_MS = 60 * 1000; // disconnected players are removed from the lobby after this
const FINISHED_TTL_MS = 15 * 60 * 1000; // finished games are cleaned up after this
const MAX_STREAK_BONUS = 500;
const TABLE_MIN_SEATS = 8; // seats drawn around an empty table
const TABLE_GROW_BY = 4; // seats added each time the table fills up
const RECONNECT_GRACE_MS = 15 * 1000; // a question won't end early while a player is reconnecting

const newToken = () => crypto.randomBytes(18).toString('base64url');

class Game {
  constructor({ io, pin, set, gameId = 'trivia', gameName = 'Trivia', mode = 'correct', joinUrl, qr, maxPlayers, onDispose }) {
    this.io = io;
    this.pin = pin;
    this.set = set;
    this.gameId = gameId;
    this.gameName = gameName;
    this.mode = mode; // 'correct' (trivia) | 'majority' — see games.js
    this.lastCorrect = [];
    this.joinUrl = joinUrl;
    this.qr = qr;
    this.maxPlayers = maxPlayers;
    this.onDispose = onDispose;

    this.hostToken = newToken();
    this.hostSocketId = null;
    this.hostGraceTimer = null;

    this.players = new Map(); // playerId -> player
    this.state = 'lobby'; // lobby | intro | question | reveal | scoreboard | finished
    this.locked = false;
    this.qIndex = -1;
    this.timer = null;
    this.phaseEndsAt = 0;
    this.questionStartedAt = 0;
    this.lastCounts = [];
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
      score: 0,
      streak: 0,
      correctCount: 0,
      lastPoints: 0,
      answer: null, // { index, ms } for the current question
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
    this.checkAllAnswered();
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
    this.checkAllAnswered();
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

  /** Seats around the table for the host screen: who has answered (question) or what they chose (reveal). */
  seatList(reveal = false) {
    return this.seated().map((p) =>
      reveal
        ? { id: p.id, seat: p.seat, name: p.name, choice: p.answer ? p.answer.index : null }
        : { id: p.id, seat: p.seat, name: p.name, answered: !!p.answer }
    );
  }

  sendLobbyUpdate() {
    this.toHost('host:players', { players: this.publicPlayers(), tableSize: this.tableSize() });
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
    } else if (this.state === 'question') {
      this.reveal(); // "Skip" — end the question now
    }
  }

  nextQuestion() {
    clearTimeout(this.timer);
    this.qIndex += 1;
    this.state = 'intro';
    this.phaseEndsAt = Date.now() + INTRO_MS;
    for (const p of this.players.values()) p.answer = null;
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
    this.toPlayer(player, 'player:state', { phase: 'answered', ...this.playerBase(player) });
    this.toHost('host:answers', {
      answered: this.answeredCount(),
      playerCount: this.players.size,
      seats: this.seatList(),
      tableSize: this.tableSize(),
    });
    this.checkAllAnswered();
  }

  answeredCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.answer) n++;
    return n;
  }

  checkAllAnswered() {
    if (this.state !== 'question') return;
    // Players who dropped out recently (e.g. phone screen locked) still get waited for.
    const now = Date.now();
    const active = [...this.players.values()].filter(
      (p) => p.connected || p.answer || now - p.disconnectedAt < RECONNECT_GRACE_MS
    );
    if (active.length > 0 && active.every((p) => p.answer)) this.reveal();
  }

  /** The answer indexes that score this question. Ties in Majority Rules all count. */
  winningAnswers(q, counts) {
    if (this.mode !== 'majority') return q.correct;
    const top = Math.max(0, ...counts);
    return top === 0 ? [] : counts.flatMap((c, i) => (c === top ? [i] : []));
  }

  reveal() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    const q = this.question;
    const limitMs = q.time * 1000;
    const counts = new Array(q.answers.length).fill(0);
    for (const p of this.players.values()) if (p.answer) counts[p.answer.index] += 1;

    // Which answers score: the right ones (trivia), or the most popular ones (Majority Rules).
    const winning = this.winningAnswers(q, counts);
    this.lastCorrect = winning;

    for (const p of this.players.values()) {
      let points = 0;
      const correct = Boolean(p.answer && winning.includes(p.answer.index));
      if (correct) {
        p.streak += 1;
        p.correctCount += 1;
        if (q.points !== 'none') {
          // Faster answers earn more: 1000 points instantly, down to 500 at the buzzer.
          const ratio = Math.min(1, p.answer.ms / limitMs);
          points = Math.round(1000 * (1 - ratio / 2));
          if (q.points === 'double') points *= 2;
          points += Math.min((p.streak - 1) * 100, MAX_STREAK_BONUS);
        }
      } else {
        p.streak = 0;
      }
      p.score += points;
      p.lastPoints = points;
      p.lastResult = { answered: !!p.answer, correct, points, streak: p.streak, mode: this.mode };
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

    this.lastCounts = counts;
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
          credit: q.credit || null, // e.g. "Open Trivia DB · CC BY-SA 4.0" for online questions
          image: q.image,
          answers: q.answers,
          correct: this.lastCorrect,
          counts: this.lastCounts,
          answered: this.lastCounts.reduce((a, b) => a + b, 0),
          correctCount: this.lastCorrect.reduce((sum, i) => sum + (this.lastCounts[i] || 0), 0),
          playerCount: this.players.size,
          isLast: this.isLastQuestion,
          seats: this.seatList(true),
          tableSize: this.tableSize(),
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
      gameName: this.gameName,
    };
  }

  sendPlayerState(p) {
    const base = this.playerBase(p);
    let payload;
    switch (this.state) {
      case 'lobby':
        payload = { phase: 'lobby', ...base, title: this.set.title };
        break;
      case 'intro':
        payload = { phase: 'intro', ...base, timeLeft: this.timeLeft(), points: this.question.points };
        break;
      case 'question':
        payload = p.answer
          ? { phase: 'answered', ...base }
          : {
              phase: 'question',
              ...base,
              answers: this.question.answers,
              question: this.question.question,
              time: this.question.time,
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
