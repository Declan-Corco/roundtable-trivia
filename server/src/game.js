// One Game = one table: one lobby with one host screen and many players.
// The server is authoritative: it owns the timers, the bets, the answers and the scores.
//
// Two kinds of game run on it (see games.js):
//   Wager Wars ('wager')  — each question: bet (the category is shown, everyone bets some points)
//                            → get ready → answer A-D → reveal (right wins the bet, wrong loses it) → standings.
//   Only One ('onlyone')  — each round: get ready (the category) → every table types as many answers as
//                            it can → the server groups answers that mean the same thing (matcher.js) →
//                            the host checks the groups (merge / split / reject) → answers only one table
//                            wrote score 100 each → standings.
//   Split Decision ('split') — each round: get ready (the question) → everyone secretly picks one of two
//                            answers → every table guesses what percent of the room picked the first →
//                            reveal (the real split; points for how close each guess was) → standings.
//
// After the last question the host can play again with the same table: everyone goes back to the
// lobby (same PIN) while the host picks the next game. Players can join at any point.
const crypto = require('crypto');
const config = require('./config');
const matcher = require('./matcher');
const aicheck = require('./aicheck');
const { screen } = require('./screen');

const INTRO_MS = 4000; // "Get ready" screen before answers open
const HOST_GRACE_MS = 2 * 60 * 1000; // host can refresh/reconnect within this window
const LOBBY_DROP_MS = 60 * 1000; // disconnected players are removed from the lobby after this
const FINISHED_TTL_MS = 15 * 60 * 1000; // a finished game whose host has left is cleaned up after this
const TABLE_MIN_SEATS = 8; // seats drawn around an empty table
const TABLE_GROW_BY = 4; // seats added each time the table fills up
const RECONNECT_GRACE_MS = 15 * 1000; // a phase won't end early while a player is reconnecting

const START_BANK = 1000; // everyone starts with this many points to bet with
const WAGER_FLOOR = 500; // you can always bet up to this much, even with fewer points

// Only One
const UNIQUE_POINTS = 100; // per answer no other table wrote
const MAX_LIST = 40; // answers per table per round
const MAX_ANSWER_LEN = 50;
const GRADING_MIN_MS = 1800; // the grading screen shows at least this long, so it doesn't just flash
const REVIEW_MIN_AUTO_MS = 20 * 1000; // in auto mode, the results stay up at least this long, whatever the setting

// Split Decision: a guess scores SPLIT_POINTS when spot on, falling in a straight line to 0 at
// SPLIT_RANGE percentage points off (10 off = 80, 25 off = 50). The closest guess (ties included)
// also gets SPLIT_BONUS.
const SPLIT_POINTS = 100;
const SPLIT_RANGE = 50;
const SPLIT_BONUS = 50;
/** Points for a guess `off` percentage points from the room's real split. */
const splitPoints = (off) => Math.round(SPLIT_POINTS * Math.max(0, 1 - off / SPLIT_RANGE));

const newToken = () => crypto.randomBytes(18).toString('base64url');
/** What a right answer pays per point bet: double-points questions pay 2x, practice questions 0. */
const multiplier = (q) => (q.points === 'double' ? 2 : q.points === 'none' ? 0 : 1);

class Game {
  constructor({ io, pin, set, kind = 'wager', gameName = 'Wager Wars', wagerTime = 15, autoAdvance = 0, joinUrl, qr, maxPlayers, onDispose }) {
    this.io = io;
    this.pin = pin;
    this.set = set;
    this.kind = kind; // 'wager' | 'onlyone' | 'split'
    this.gameName = gameName;
    this.wagerTime = wagerTime; // seconds to place a bet
    this.autoAdvance = autoAdvance; // seconds before the reveal / results / standings move on by themselves (0 = manual)
    this.autoTimer = null;
    this.autoAt = 0; // when the current screen moves on by itself
    this.lastReveal = null; // what the host screen shows after a question
    this.choosing = false; // in the lobby while the host picks the next game (set may be null)
    this.entries = new Map(); // Only One: this round's answers by id { id, text, playerId, rejected }
    this.groups = null; // Only One: answers that count as the same [{ id, ids: [entry ids], ai? }]
    this.ai = null; // Only One: Claude's check of this round { status, ... } (when the server has an API key)
    this.gradingStep = null; // Only One: 'matching' | 'checking' while the grading screen is up
    this.seq = 0; // ids for answers and groups
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
    return this.set?.questions[this.qIndex];
  }
  get total() {
    return this.set ? this.set.questions.length : 0;
  }
  get isLastQuestion() {
    return this.qIndex >= this.total - 1;
  }
  get startScore() {
    return this.kind === 'wager' ? START_BANK : 0;
  }
  /** What one step of the game is called on screen. */
  get unit() {
    return this.kind === 'wager' ? 'Question' : 'Round';
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
    // On the final screen players can keep looking at their results for a while.
    this.hostGraceTimer =
      this.state === 'finished'
        ? setTimeout(() => this.dispose(), FINISHED_TTL_MS)
        : setTimeout(() => this.end('The host left the game.'), HOST_GRACE_MS);
  }

  isHost(socket) {
    return socket.id === this.hostSocketId;
  }

  toHost(event, payload) {
    if (this.hostSocketId) this.io.to(this.hostSocketId).emit(event, payload);
  }

  // --------------------------------------------------------------- players

  addPlayer(socket, rawName) {
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
      score: this.startScore,
      streak: 0,
      correctCount: 0,
      lastPoints: 0,
      answer: null, // for the current question: { index, ms }
      wager: null, // the bet on the current question
      list: [], // Only One: this round's answers [{ id, text, key }]
      done: false, // Only One: finished typing for this round
      guess: null, // Split Decision: percent of the room this table thinks picked the first answer
      lastResult: null,
      spectator: this.state === 'finished', // joined after the last question: plays from the next game
      socketId: null,
      connected: false,
      disconnectedAt: 0,
      dropTimer: null,
    };
    this.players.set(player.id, player);
    this.attachPlayer(socket, player);
    // Late joiners: let the host know (in the lobby the guest list already shows them).
    if (this.state !== 'lobby') this.toHost('host:joined', { name: player.name, seat: player.seat });
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
    if (this.state === 'lobby') this.scheduleDrop(player);
    this.sendLobbyUpdate();
    this.checkAllIn();
  }

  /** In the lobby, a player who has gone (and doesn't come back within a minute) loses their seat. */
  scheduleDrop(player) {
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      if (!player.connected && this.state === 'lobby') {
        this.players.delete(player.id);
        this.sendLobbyUpdate();
      }
    }, LOBBY_DROP_MS);
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

  /** Has this player done what the current phase asks: placed a bet (wager), answered (question) or guessed (guess)? */
  isIn(p) {
    if (this.state === 'wager') return p.wager != null;
    if (this.state === 'guess') return p.guess != null;
    return this.kind === 'onlyone' ? p.done : !!p.answer;
  }

  /** Seats around the table for the host screen: who is in (wager/question) or what they chose (reveal). */
  seatList(reveal = false) {
    return this.seated().map((p) =>
      reveal
        ? { id: p.id, seat: p.seat, name: p.name, choice: p.answer?.index ?? null }
        : { id: p.id, seat: p.seat, name: p.name, answered: this.isIn(p), count: p.list.length }
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
      answerCount: this.answerCount(),
      playerCount: this.players.size,
      seats: this.seatList(),
      tableSize: this.tableSize(),
    });
  }

  /** Only One: how many answers have been typed so far this round, across every table. */
  answerCount() {
    let n = 0;
    for (const p of this.players.values()) n += p.list.length;
    return n;
  }

  leaderboard() {
    return [...this.players.values()]
      .filter((p) => !p.spectator)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------- game flow

  setLocked(locked) {
    this.locked = !!locked;
    this.sendHostState();
  }

  start() {
    if (this.state !== 'lobby') throw new Error('The game has already started.');
    if (this.choosing || !this.set) throw new Error('Pick a game first.');
    if (this.players.size === 0) throw new Error('Wait for at least one player to join.');
    this.nextQuestion();
  }

  /**
   * Back to the lobby so the host can pick a (new) game; everyone keeps their seat.
   * After a finished game the scores reset and the old questions are dropped.
   */
  reopen() {
    if (this.state !== 'finished' && this.state !== 'lobby') throw new Error('Finish this game first.');
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.autoAt = 0;
    if (this.state === 'finished') {
      this.set = null;
      this.resetScores();
    }
    this.state = 'lobby';
    this.choosing = true;
    for (const p of this.players.values()) if (!p.connected) this.scheduleDrop(p);
    this.touch();
    this.broadcastState();
  }

  /** The host picked the next game: load its questions and wait in the lobby for "Start". */
  loadRound({ set, kind = 'wager', gameName, wagerTime, autoAdvance = 0 }) {
    if (this.state !== 'lobby') throw new Error('Finish this game first.');
    this.set = set;
    this.kind = kind;
    this.autoAdvance = autoAdvance;
    this.gameName = gameName;
    this.wagerTime = wagerTime;
    this.choosing = false;
    this.qIndex = -1;
    this.resetScores();
    this.touch();
    this.broadcastState();
    console.log(`[game ${this.pin}] next game — ${gameName}: "${set.title}" (${set.questions.length} questions)`);
  }

  /** The host changed their mind about picking a new game: keep the one already loaded. */
  cancelChoosing() {
    if (this.state !== 'lobby' || !this.set) throw new Error('Pick a game first.');
    this.choosing = false;
    this.broadcastState();
  }

  resetScores() {
    this.qIndex = -1;
    this.lastReveal = null;
    this.groups = null;
    this.entries = new Map();
    for (const p of this.players.values()) {
      Object.assign(p, { score: this.startScore, streak: 0, correctCount: 0, lastPoints: 0, prevRank: 0, answer: null, wager: null, list: [], done: false, guess: null, lastResult: null, spectator: false });
    }
  }

  /**
   * Auto mode: the reveal, Only One's results and the standings move on by themselves after
   * `autoAdvance` seconds (Only One's results at least REVIEW_MIN_AUTO_MS, so the room can read
   * them). The host can still press to go sooner (or edit, which restarts it).
   */
  scheduleAuto() {
    clearTimeout(this.autoTimer);
    this.autoAt = 0;
    if (!this.autoAdvance) return;
    const ms = this.state === 'review' ? Math.max(this.autoAdvance * 1000, REVIEW_MIN_AUTO_MS) : this.autoAdvance * 1000;
    const state = this.state;
    const round = this.qIndex;
    this.autoMs = ms;
    this.autoAt = Date.now() + ms;
    this.autoTimer = setTimeout(() => {
      if (!this.disposed && this.state === state && this.qIndex === round) this.next();
    }, ms);
  }

  /** For the host screen: how long until it moves on by itself. */
  autoInfo() {
    return this.autoAt ? { left: Math.max(0, this.autoAt - Date.now()), total: this.autoMs } : null;
  }

  next() {
    clearTimeout(this.autoTimer);
    this.autoAt = 0;
    if (this.state === 'reveal') {
      if (this.isLastQuestion) this.finish();
      else this.showScoreboard();
    } else if (this.state === 'review') {
      this.scoreRound(); // Only One: the host is happy with the groups
      if (this.isLastQuestion) this.finish();
      else this.showScoreboard();
    } else if (this.state === 'scoreboard') {
      this.nextQuestion();
    } else if (this.state === 'wager') {
      this.startIntro(); // "Close bets" — anyone who hasn't bet is betting nothing
    } else if (this.state === 'question') {
      this.closeAnswers(); // "Skip" / "Time's up" — end the question now
    } else if (this.state === 'guess') {
      this.revealSplit(); // Split Decision: "Close guesses"
    }
  }

  nextQuestion() {
    clearTimeout(this.timer);
    this.qIndex += 1;
    for (const p of this.players.values()) {
      p.answer = null;
      p.wager = null;
      p.list = [];
      p.done = false;
      p.guess = null;
    }
    this.groups = null;
    this.entries = new Map();
    this.ai = null;
    if (this.kind === 'wager') this.openWagers();
    else this.startIntro();
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
    this.timer = setTimeout(() => this.closeAnswers(), q.time * 1000 + 250); // small grace for latency
  }

  /** Time's up (or everyone is in): score the question; Only One groups the answers; Split Decision moves on to guessing. */
  closeAnswers() {
    if (this.kind === 'onlyone') this.review();
    else if (this.kind === 'split') this.openGuesses();
    else this.reveal();
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

  /** Moves on early once everyone has bet (wager), answered (question) or guessed (guess). */
  checkAllIn() {
    if (this.state !== 'question' && this.state !== 'wager' && this.state !== 'guess') return;
    // Players who dropped out recently (e.g. phone screen locked) still get waited for.
    const now = Date.now();
    const active = [...this.players.values()].filter(
      (p) => p.connected || this.isIn(p) || now - p.disconnectedAt < RECONNECT_GRACE_MS
    );
    if (!active.length || !active.every((p) => this.isIn(p))) return;
    if (this.state === 'wager') this.startIntro();
    else if (this.state === 'guess') this.revealSplit();
    else this.closeAnswers();
  }

  // ------------------------------------------------------------- scoring

  /** After scoring: each player's place and who's just ahead, and everyone's rank before this round. */
  rankResults() {
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
  }

  // ------------------------------------------------------------- Only One

  playerFor(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('You are not in this game.');
    return player;
  }

  publicList(p) {
    return p.list.map(({ id, text }) => ({ id, text }));
  }

  addListAnswer(playerId, raw) {
    if (this.kind !== 'onlyone' || this.state !== 'question') throw new Error("Time's up for this round.");
    const p = this.playerFor(playerId);
    const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_LEN);
    const key = matcher.keyOf(text);
    if (!key) throw new Error('Type an answer first.');
    if (p.list.length >= MAX_LIST) throw new Error(`That's ${MAX_LIST} answers, the most for one round.`);
    if (p.list.some((a) => a.key === key)) throw new Error('You already have that one.');
    p.list.push({ id: `a${++this.seq}`, text, key });
    this.touch();
    this.sendProgress();
    return { list: this.publicList(p) };
  }

  removeListAnswer(playerId, id) {
    if (this.kind !== 'onlyone' || this.state !== 'question') throw new Error("Time's up for this round.");
    const p = this.playerFor(playerId);
    p.list = p.list.filter((a) => a.id !== String(id));
    this.touch();
    this.sendProgress();
    return { list: this.publicList(p) };
  }

  /** "I'm done" (or "keep going"). Once every table is done the round ends early. */
  setListDone(playerId, done) {
    if (this.kind !== 'onlyone' || this.state !== 'question') throw new Error("Time's up for this round.");
    const p = this.playerFor(playerId);
    p.done = !!done;
    this.touch();
    this.sendPlayerState(p);
    this.sendProgress();
    this.checkAllIn();
  }

  /**
   * Grading, while the host sees a spinning logo: group this round's answers (rules + the local
   * model, see matcher.js), reject nonsense and other languages locally (screen.js), then (with an
   * API key) let Claude check the rest (aicheck.js). The results
   * appear once both are done; the host can still change anything before scoring.
   */
  async review() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    const round = this.qIndex;
    const started = Date.now();
    const stillGrading = () => !this.disposed && this.state === 'grouping' && this.qIndex === round;
    this.state = 'grouping';
    this.gradingStep = 'matching';
    this.ai = null;
    this.touch();
    this.broadcastState();

    const entries = [];
    for (const p of this.players.values()) for (const a of p.list) entries.push({ id: a.id, text: a.text, playerId: p.id, rejected: false });
    this.entries = new Map(entries.map((e) => [e.id, e]));
    let grouped;
    try {
      grouped = await matcher.group(entries, this.question.question);
    } catch (err) {
      console.warn(`[game ${this.pin}] grouping failed, every answer stands alone: ${err.message}`);
      grouped = entries.map((e) => [e.id]);
    }
    if (!stillGrading()) return;
    this.groups = grouped.map((ids) => ({ id: `g${++this.seq}`, ids }));
    const screened = this.screenAnswers();

    if (aicheck.enabled() && entries.some((e) => !e.rejected)) {
      this.gradingStep = 'checking';
      this.broadcastState();
      await this.runAiCheck();
      if (!stillGrading()) return;
    }

    if (screened) {
      if (!this.ai) this.ai = { status: 'done', rejected: 0, merged: 0, split: 0 }; // no Claude check, or nothing left for it
      if (this.ai.status === 'done') this.ai.rejected += screened;
    }

    const wait = GRADING_MIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!stillGrading()) return;
    this.gradingStep = null;
    this.state = 'review';
    this.scheduleAuto();
    this.touch();
    this.broadcastState();
  }

  /**
   * Rejects answers that can't be right (keyboard mashing, "idk", another language; see screen.js)
   * before Claude sees the round, so they aren't sent. Returns how many were rejected.
   */
  screenAnswers() {
    const caught = {};
    for (const e of this.entries.values()) {
      const why = screen(e.text, this.question.question);
      if (!why) continue;
      e.rejected = true;
      e.ai = true; // shown as "reviewed"; the host can still allow it
      e.aiWhy = why;
      (caught[why] ||= []).push(e.text);
    }
    const n = Object.values(caught).flat().length;
    if (n) console.log(`[game ${this.pin}] screened out ${n} answer${n === 1 ? '' : 's'}: ` + Object.entries(caught).map(([why, t]) => `${why} (${t.join(', ')})`).join('; '));
    return n;
  }

  /** Claude checks the round (gives up after AI_CHECK_WAIT_MS) and its changes are applied to the groups. */
  async runAiCheck() {
    const groups = this.groups
      .map((g) => ({ id: g.id, entries: g.ids.map((id) => this.entries.get(id)).filter((e) => e && !e.rejected).map((e) => ({ id: e.id, text: e.text })) }))
      .filter((g) => g.entries.length);
    let result;
    let timer;
    try {
      const giveUp = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('it took too long')), config.AI_CHECK_WAIT_MS);
      });
      result = await Promise.race([aicheck.check(this.question.question, groups), giveUp]);
    } catch (err) {
      console.warn(`[game ${this.pin}] Claude check failed: ${err.message}`);
      this.ai = { status: 'error', message: err.message };
      return;
    } finally {
      clearTimeout(timer);
    }
    const u = result.usage || {};
    console.log(
      `[game ${this.pin}] Claude check: judged ${result.judged}/${result.total} answers in ${result.parts} part${result.parts === 1 ? '' : 's'}` +
        (result.failedParts ? ` (${result.failedParts} failed)` : '') + `, rejected ${result.misfits.length}` +
        (result.distinct && result.distinct < result.total ? ` (${result.distinct} different wordings)` : '') +
        (result.dropped ? ` (ignored ${result.dropped} unknown)` : '') + '; ' +
        `${u.input_tokens ?? '?'} in / ${u.output_tokens ?? '?'} out tokens, ~$${aicheck.costOf(u).toFixed(5)}, ${(result.ms / 1000).toFixed(1)} s`
    );
    let split = 0;
    for (const id of result.split) {
      const g = this.groups.find((x) => x.ids.includes(id));
      if (!g || g.ids.length < 2) continue;
      g.ids = g.ids.filter((x) => x !== id);
      this.groups.splice(this.groups.indexOf(g) + 1, 0, { id: `g${++this.seq}`, ids: [id], ai: 'split' });
      split++;
    }
    let merged = 0;
    for (const set of result.merge) {
      const parts = set.map((gid) => this.groups.find((g) => g.id === gid)).filter(Boolean);
      if (parts.length < 2) continue;
      const [into, ...rest] = parts;
      for (const g of rest) into.ids.push(...g.ids);
      into.ai = 'merged';
      this.groups = this.groups.filter((g) => !rest.includes(g));
      merged++;
    }
    let rejected = 0;
    for (const { id, why } of result.misfits) {
      const e = this.entries.get(id);
      if (!e || e.rejected) continue;
      e.rejected = true;
      e.ai = true;
      e.aiWhy = why; // a reason for the host, if Claude gave one (currently it just says good or not)
      rejected++;
    }
    this.ai = { status: 'done', rejected, merged, split };
  }

  /** 'unique' (one table wrote it: it scores), 'shared' (several did: nobody scores) or 'rejected'. */
  groupStatus(g) {
    const tables = new Set(g.ids.map((id) => this.entries.get(id)).filter((e) => e && !e.rejected).map((e) => e.playerId));
    return tables.size === 0 ? 'rejected' : tables.size === 1 ? 'unique' : 'shared';
  }

  /**
   * The host fixes the grouping before scoring:
   *   { action: 'merge', group, into }  — these two groups are the same answer
   *   { action: 'split', entry }        — this answer isn't the same as the rest of its group
   *   { action: 'reject', entry }       — this answer doesn't fit the category (again to undo)
   */
  editGroups({ action, group, into, entry } = {}) {
    if (this.kind !== 'onlyone' || this.state !== 'review') throw new Error('Nothing to check right now.');
    const find = (gid) => this.groups.find((g) => g.id === String(gid));
    if (action === 'merge') {
      const from = find(group);
      const to = find(into);
      if (!from || !to || from === to) throw new Error('Pick two different groups to merge.');
      to.ids.push(...from.ids);
      this.groups = this.groups.filter((g) => g !== from);
    } else if (action === 'split') {
      const g = this.groups.find((x) => x.ids.includes(String(entry)));
      if (!g || g.ids.length < 2) throw new Error('That answer is already on its own.');
      g.ids = g.ids.filter((id) => id !== String(entry));
      this.groups.splice(this.groups.indexOf(g) + 1, 0, { id: `g${++this.seq}`, ids: [String(entry)] });
    } else if (action === 'reject') {
      const e = this.entries.get(String(entry));
      if (!e) throw new Error('That answer is gone.');
      e.rejected = !e.rejected;
      e.ai = false; // the host's call now
      e.aiWhy = '';
    } else {
      throw new Error('Unknown change.');
    }
    this.scheduleAuto(); // the host is busy here: restart the countdown
    this.touch();
    this.broadcastState();
  }

  /** How each of this player's answers did: unique (scores), repeat (their own duplicate), shared or rejected. */
  myStatuses(p) {
    if (!this.groups) return p.list.map((a) => ({ text: a.text, status: null }));
    const counted = new Set(); // unique groups already credited to this player
    return p.list.map((a) => {
      const e = this.entries.get(a.id);
      const g = this.groups.find((x) => x.ids.includes(a.id));
      if (!e || !g) return { text: a.text, status: null };
      if (e.rejected) return { text: a.text, status: 'rejected' };
      const status = this.groupStatus(g);
      if (status === 'unique') {
        if (counted.has(g.id)) return { text: a.text, status: 'repeat' };
        counted.add(g.id);
        return { text: a.text, status: 'unique' };
      }
      const others = [...new Set(g.ids.map((id) => this.entries.get(id)).filter((x) => x && !x.rejected && x.playerId !== p.id).map((x) => this.players.get(x.playerId)?.name).filter(Boolean))];
      return { text: a.text, status: 'shared', with: others };
    });
  }

  /** Each answer only one table wrote scores UNIQUE_POINTS for that table. */
  scoreRound() {
    const points = new Map();
    for (const g of this.groups || []) {
      if (this.groupStatus(g) !== 'unique') continue;
      const e = g.ids.map((id) => this.entries.get(id)).find((x) => x && !x.rejected);
      points.set(e.playerId, (points.get(e.playerId) || 0) + 1);
    }
    for (const p of this.players.values()) {
      const unique = points.get(p.id) || 0;
      const mine = this.myStatuses(p);
      p.lastPoints = unique * UNIQUE_POINTS;
      p.score += p.lastPoints;
      p.correctCount += unique;
      p.streak = 0;
      p.lastResult = {
        kind: 'onlyone',
        answered: p.list.length > 0,
        correct: unique > 0,
        points: p.lastPoints,
        unique,
        shared: mine.filter((m) => m.status === 'shared').length,
        rejected: mine.filter((m) => m.status === 'rejected').length,
        mine,
        streak: 0,
      };
    }
    this.rankResults();
  }

  // ------------------------------------------------------------- Split Decision

  /** Votes are in: every table now guesses what percent of the room picked the first answer. */
  openGuesses() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    if (!this.splitCounts().votes) return this.revealSplit(); // nobody picked a side: nothing to guess
    const q = this.question;
    this.state = 'guess';
    this.phaseEndsAt = Date.now() + q.guessTime * 1000;
    this.touch();
    this.broadcastState();
    this.timer = setTimeout(() => this.revealSplit(), q.guessTime * 1000 + 250);
  }

  /** How the room voted: [first answer, second answer] and the total. */
  splitCounts() {
    const counts = [0, 0];
    for (const p of this.players.values()) if (p.answer) counts[p.answer.index] += 1;
    return { counts, votes: counts[0] + counts[1] };
  }

  submitGuess(playerId, value) {
    if (this.kind !== 'split' || this.state !== 'guess') throw new Error('Too late — guesses are closed.');
    const player = this.playerFor(playerId);
    if (player.guess != null) throw new Error('You already locked in your guess.');
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) throw new Error('Invalid guess.');
    player.guess = Math.min(100, Math.max(0, n));
    this.touch();
    this.sendPlayerState(player);
    this.sendProgress();
    this.checkAllIn();
  }

  /** The real split: each guess scores by how close it was, and the closest table gets a bonus. */
  revealSplit() {
    if (this.state !== 'guess' && this.state !== 'question') return;
    clearTimeout(this.timer);
    const q = this.question;
    const { counts, votes } = this.splitCounts();
    const actual = votes ? (counts[0] / votes) * 100 : null; // percent who picked the first answer
    const guessed = [...this.players.values()].filter((p) => p.guess != null);
    const best = actual == null || !guessed.length ? null : Math.min(...guessed.map((p) => Math.abs(p.guess - actual)));

    for (const p of this.players.values()) {
      const voted = p.answer?.index ?? null;
      if (actual == null || p.guess == null) {
        p.lastPoints = 0;
        p.streak = 0;
        p.lastResult = { kind: 'split', answered: p.guess != null, noVotes: actual == null, correct: false, points: 0, guess: p.guess, voted, answers: q.answers, streak: 0 };
        continue;
      }
      const off = Math.abs(p.guess - actual);
      const closest = off - best < 1e-9;
      const points = splitPoints(off) + (closest ? SPLIT_BONUS : 0);
      p.score += points;
      p.lastPoints = points;
      if (closest) {
        p.correctCount += 1; // the final screen counts closest guesses
        p.streak += 1;
      } else {
        p.streak = 0;
      }
      p.lastResult = {
        kind: 'split',
        answered: true,
        correct: closest || off <= 10,
        closest,
        bonus: closest ? SPLIT_BONUS : 0,
        points,
        guess: p.guess,
        actual: Math.round(actual),
        off: Math.round(off),
        voted,
        answers: q.answers,
        streak: p.streak,
      };
    }
    this.rankResults();

    this.lastReveal = {
      answers: q.answers,
      counts,
      votes,
      actual: actual == null ? null : Math.round(actual),
      bonus: SPLIT_BONUS,
      guesses: (actual == null ? [] : guessed)
        .map((p) => ({ id: p.id, name: p.name, seat: p.seat, guess: p.guess, off: Math.round(Math.abs(p.guess - actual)), points: p.lastPoints, closest: !!p.lastResult.closest }))
        .sort((a, b) => a.off - b.off || b.points - a.points || a.seat - b.seat),
    };
    this.state = 'reveal';
    this.scheduleAuto();
    this.touch();
    this.broadcastState();
  }

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
      p.lastResult = { kind: 'wager', answered: !!p.answer, correct, wager, points, streak: p.streak };
    }
    this.rankResults();

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
    this.scheduleAuto();
    this.touch();
    this.broadcastState();
  }

  showScoreboard() {
    this.state = 'scoreboard';
    this.scheduleAuto();
    this.touch();
    this.broadcastState();
  }

  finish() {
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.autoAt = 0;
    this.state = 'finished';
    this.touch();
    this.broadcastState();
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
    clearTimeout(this.autoTimer);
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
      joinUrl: this.joinUrl,
      title: this.set?.title || '',
      kind: this.kind,
      unit: this.unit,
      gameName: this.gameName,
      index: this.qIndex,
      total: this.total,
    };
    let payload;
    if (this.state === 'reveal' && this.kind === 'split') {
      // The room's real split and every table's guess (not who voted which way: votes stay private).
      payload = { phase: 'reveal', ...common, question: q.question, isLast: this.isLastQuestion, playerCount: this.players.size, auto: this.autoInfo(), ...this.lastReveal };
      return this.toHost('host:state', payload);
    }
    switch (this.state) {
      case 'lobby':
        payload = {
          phase: 'lobby',
          ...common,
          choosing: this.choosing || !this.set, // the host is picking the next game
          hasRound: !!this.set,
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
          category: q.category || null,
          points: q.points,
          time: q.time,
          timeLeft: this.timeLeft(),
          answered: this.answeredCount(),
          answerCount: this.answerCount(),
          playerCount: this.players.size,
          seats: this.seatList(),
          tableSize: this.tableSize(),
        };
        break;
      case 'guess': // Split Decision: tables guess the split
        payload = {
          phase: 'guess',
          ...common,
          question: q.question,
          answers: q.answers,
          category: q.category || null,
          time: q.guessTime,
          timeLeft: this.timeLeft(),
          votes: this.splitCounts().votes,
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
          auto: this.autoInfo(),
          ...this.lastReveal,
        };
        break;
      case 'grouping':
        payload = {
          phase: 'grouping',
          ...common,
          question: q.question,
          category: q.category || null,
          answerCount: this.entries.size,
          playerCount: this.players.size,
          step: this.gradingStep, // 'matching' | 'checking'
          review: aicheck.enabled(), // whether there's a review step at all
        };
        break;
      case 'review': {
        const groups = this.groups.map((g) => {
          const status = this.groupStatus(g);
          return {
            id: g.id,
            status,
            ai: g.ai || null, // 'merged' / 'split' when Claude changed this group
            points: status === 'unique' ? UNIQUE_POINTS : 0,
            entries: g.ids.map((id) => {
              const e = this.entries.get(id);
              const p = this.players.get(e.playerId);
              return { id, text: e.text, rejected: e.rejected, ai: !!e.ai, why: e.aiWhy || '', seat: p?.seat ?? 0, name: p?.name ?? 'Left the game' };
            }),
          };
        });
        payload = {
          phase: 'review',
          ...common,
          question: q.question,
          category: q.category || null,
          groups,
          ai: this.ai,
          auto: this.autoInfo(),
          isLast: this.isLastQuestion,
          playerCount: this.players.size,
        };
        break;
      }
      case 'scoreboard': {
        const board = this.leaderboard();
        payload = {
          phase: 'scoreboard',
          ...common,
          auto: this.autoInfo(),
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
          podium: this.leaderboard().slice(0, 5).map((p) => ({ name: p.name, seat: p.seat, score: p.score, correct: p.correctCount, stat: this.statText(p) })),
          playerCount: this.players.size,
        };
        break;
    }
    this.toHost('host:state', payload);
  }

  /** The line under a final score: "7/10 correct" or "12 unique answers". */
  statText(p) {
    if (this.kind === 'onlyone') return `${p.correctCount} unique answer${p.correctCount === 1 ? '' : 's'}`;
    if (this.kind === 'split') return `${p.correctCount} closest guess${p.correctCount === 1 ? '' : 'es'}`;
    return `${p.correctCount}/${this.total} correct`;
  }

  playerBase(p) {
    return {
      kind: this.kind,
      unit: this.unit,
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
    if (this.state === 'guess') return { kind: 'guess', guess: p.guess, answers: this.question.answers };
    if (!p.answer) return null;
    return { kind: 'answer', index: p.answer.index, text: this.question.answers[p.answer.index], wager: p.wager ?? 0 };
  }

  sendPlayerState(p) {
    const base = this.playerBase(p);
    const q = this.question;
    let payload;
    switch (this.state) {
      case 'lobby':
        payload = { phase: 'lobby', ...base, title: this.set?.title || '', choosing: this.choosing || !this.set };
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
        payload = {
          phase: 'intro',
          ...base,
          question: q.question,
          category: q.category || null,
          timeLeft: this.timeLeft(),
          points: q.points,
          wager: this.kind === 'wager' ? p.wager ?? 0 : null,
        };
        break;
      case 'question':
        if (this.kind === 'onlyone') {
          payload = { phase: 'list', ...base, question: q.question, category: q.category || null, time: q.time, timeLeft: this.timeLeft(), list: this.publicList(p), done: p.done };
          break;
        }
        payload = p.answer
          ? { phase: 'answered', ...base, mine: this.mine(p) }
          : {
              phase: 'question',
              ...base,
              answers: q.answers,
              question: q.question,
              wager: this.kind === 'wager' ? p.wager ?? 0 : null,
              time: q.time,
              timeLeft: this.timeLeft(),
            };
        break;
      case 'guess':
        payload =
          p.guess != null
            ? { phase: 'answered', ...base, mine: this.mine(p) }
            : {
                phase: 'guess',
                ...base,
                question: q.question,
                answers: q.answers,
                voted: p.answer?.index ?? null, // the side this table picked, as a reminder
                time: q.guessTime,
                timeLeft: this.timeLeft(),
              };
        break;
      case 'grouping':
      case 'review':
        payload = { phase: 'checking', ...base, question: q.question, mine: this.myStatuses(p) };
        break;
      case 'reveal':
      case 'scoreboard':
        payload = p.lastResult ? { phase: 'result', ...base, ...p.lastResult } : { phase: 'wait', ...base, until: 'question' };
        break;
      case 'finished': {
        if (p.spectator) {
          payload = { phase: 'wait', ...base, until: 'game' };
          break;
        }
        const board = this.leaderboard();
        payload = {
          phase: 'finished',
          ...base,
          rank: board.indexOf(p) + 1,
          playerCount: board.length,
          correctCount: p.correctCount,
          stat: this.statText(p),
        };
        break;
      }
    }
    this.toPlayer(p, 'player:state', payload);
  }
}

module.exports = { Game, newToken };
