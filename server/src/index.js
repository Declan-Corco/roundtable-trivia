// Roundtable Trivia server: serves the website (../client) and runs the games over Socket.IO.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const config = require('./config');
const { gameInfo, buildRound } = require('./games');
const sources = require('./sources');
const { Game } = require('./game');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6, // 1 MB — enough for uploaded trivia files
  pingInterval: 10000,
  pingTimeout: 20000,
});

/** @type {Map<string, Game>} */
const games = new Map();

// ------------------------------------------------------------------ HTTP

// Pages are served with a version tag (a hash of the client files) on their CSS/JS links, so
// after an update every browser and Cloudflare fetch the new files instead of stale cached ones.
function hashDir(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else hash.update(e.name).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 10);
}
const ASSET_VERSION = hashDir(config.CLIENT_DIR);
const pages = {};
for (const name of ['index', 'join', 'host']) {
  pages[name] = fs.readFileSync(path.join(config.CLIENT_DIR, `${name}.html`), 'utf8').replaceAll('__V__', ASSET_VERSION);
}
const sendPage = (name) => (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(pages[name]);
};
app.get(['/', '/index.html'], sendPage('index'));
app.get(['/join', '/join.html'], sendPage('join'));
app.get(['/host', '/host.html'], sendPage('host'));

app.use(
  express.static(config.CLIENT_DIR, {
    index: false,
    setHeaders(res) {
      // Versioned URLs never change, so they can be cached for a year; anything else is re-checked.
      res.setHeader('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  })
);
app.use('/media', express.static(path.join(config.TRIVIA_DIR, 'media')));

app.get('/api/config', (_req, res) => {
  res.json({ needsPassword: !!config.HOST_PASSWORD, allowUploads: config.ALLOW_UPLOADS });
});

// The categories and settings for the host setup screen (packs are re-read every time,
// so new .json files show up without a restart).
app.get('/api/game', (_req, res) => {
  res.json(gameInfo());
});

// Apple universal links: lets the iOS app open /join links (e.g. from the QR code) directly.
// Only served when APPLE_APP_ID is set; Apple fetches this from https://<domain>/.well-known/…
app.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (_req, res) => {
  if (!config.APPLE_APP_IDS.length) return res.status(404).json({ error: 'APPLE_APP_ID is not set' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    applinks: {
      details: [{ appIDs: config.APPLE_APP_IDS, components: [{ '/': '/join*', comment: 'Join a game' }] }],
    },
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, games: games.size }));

// ------------------------------------------------------------- helpers

/** Best guess at this machine's address on the local network (prefers 192.168.x / 10.x / 172.16-31.x). */
function lanAddress() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal) candidates.push(addr.address);
    }
  }
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) || candidates[0] || null;
}

/** Works out the URL players should open, based on how the host reached the server. */
function baseUrlFor(socket) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  const h = socket.handshake.headers;
  const proto = String(h['x-forwarded-proto'] || (socket.handshake.secure ? 'https' : 'http')).split(',')[0].trim();
  let host = String(h['x-forwarded-host'] || h.host || `localhost:${config.PORT}`).split(',')[0].trim();
  // If the host screen was opened on "localhost", phones can't use that — swap in the LAN IP.
  const m = host.match(/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i);
  if (m) {
    const ip = lanAddress();
    if (ip) host = ip + (m[2] || '');
  }
  return `${proto}://${host}`;
}

function newPin() {
  for (let i = 0; i < 1000; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!games.has(pin)) return pin;
  }
  throw new Error('Could not allocate a game PIN.');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Wraps a socket handler so errors are returned to the caller instead of crashing. */
function handler(fn) {
  return async (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      const result = await fn(data || {});
      reply({ ok: true, ...(result || {}) });
    } catch (err) {
      reply({ ok: false, error: err.message || 'Something went wrong.' });
    }
  };
}

// --------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  socket.data = {};
  let failedJoins = 0;

  const hostGame = () => {
    const game = games.get(socket.data.pin);
    if (!game || socket.data.role !== 'host' || !game.isHost(socket)) throw new Error('You are not hosting a game.');
    return game;
  };
  const playerGame = () => {
    const game = games.get(socket.data.pin);
    if (!game || socket.data.role !== 'player') throw new Error('You are not in a game.');
    return game;
  };

  // ---- host

  socket.on(
    'host:create',
    handler(async ({ packs, customSet, settings, password }) => {
      if (config.HOST_PASSWORD && !safeEqual(password || '', config.HOST_PASSWORD)) {
        throw new Error('Wrong host password.');
      }
      if (games.size >= config.MAX_GAMES) throw new Error('The server is busy. Try again later.');

      // The chosen categories + settings → the questions for this round (see games.js).
      // Online categories are fetched live here, which can take a few seconds.
      const { game: def, round: set, settings: chosen } = await buildRound({ packs, customSet, settings });

      const pin = newPin();
      const joinUrl = `${baseUrlFor(socket)}/join?pin=${pin}`;
      const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 600, errorCorrectionLevel: 'M' });
      const game = new Game({
        io,
        pin,
        set,
        gameName: def.name,
        wagerTime: chosen.wagerTime,
        joinUrl,
        qr,
        maxPlayers: config.MAX_PLAYERS,
        onDispose: (p) => games.delete(p),
      });
      games.set(pin, game);
      game.attachHost(socket);
      console.log(`[game ${pin}] created — ${def.name}: "${set.title}" (${set.questions.length} questions)`);
      return { pin, token: game.hostToken };
    })
  );

  socket.on(
    'host:rejoin',
    handler(async ({ pin, token }) => {
      const game = games.get(String(pin));
      if (!game || !token || !safeEqual(token, game.hostToken)) throw new Error('That game is no longer running.');
      game.attachHost(socket);
    })
  );

  socket.on('host:start', handler(async () => hostGame().start()));
  socket.on('host:next', handler(async () => hostGame().next()));
  socket.on('host:lock', handler(async ({ locked }) => hostGame().setLocked(locked)));
  socket.on('host:kick', handler(async ({ playerId }) => hostGame().kick(String(playerId))));
  socket.on(
    'host:end',
    handler(async () => {
      const game = hostGame();
      if (game.state === 'finished') game.dispose();
      else game.end('The host ended the game.');
    })
  );

  // ---- players

  socket.on(
    'player:join',
    handler(async ({ pin, name }) => {
      if (failedJoins >= 15) throw new Error('Too many attempts. Refresh the page and try again.');
      const game = games.get(String(pin || '').replace(/\D/g, ''));
      if (!game) {
        failedJoins++;
        throw new Error("We couldn't find a game with that PIN.");
      }
      if (socket.data.role === 'host') throw new Error('This tab is hosting a game.');
      const player = game.addPlayer(socket, name);
      return { pin: game.pin, token: player.token, name: player.name };
    })
  );

  socket.on(
    'player:rejoin',
    handler(async ({ pin, token }) => {
      const game = games.get(String(pin));
      const player = game && token ? game.findPlayerByToken(String(token)) : null;
      if (!player) throw new Error('That game is no longer running.');
      game.attachPlayer(socket, player);
      return { pin: game.pin, name: player.name };
    })
  );

  socket.on(
    'player:answer',
    handler(async ({ index }) => {
      const game = playerGame();
      game.submitAnswer(socket.data.playerId, index);
    })
  );

  socket.on(
    'player:wager',
    handler(async ({ amount }) => {
      const game = playerGame();
      game.submitWager(socket.data.playerId, amount);
    })
  );

  socket.on(
    'player:leave',
    handler(async () => {
      const game = games.get(socket.data.pin);
      if (game && socket.data.role === 'player') game.kick(socket.data.playerId);
      socket.data = {};
    })
  );

  socket.on('disconnect', () => {
    const game = games.get(socket.data.pin);
    if (!game) return;
    if (socket.data.role === 'host') game.hostDisconnected(socket.id);
    else if (socket.data.role === 'player') game.playerDisconnected(socket.data.playerId, socket.id);
  });
});

// Clean up abandoned games (no activity for 3 hours).
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const game of games.values()) if (game.lastActivity < cutoff) game.end('This game expired.');
}, 60 * 1000).unref();

// --------------------------------------------------------------- start

server.listen(config.PORT, config.HOST, () => {
  const lan = lanAddress();
  console.log('');
  console.log('  roundtable is running');
  console.log(`  Host screen:  http://localhost:${config.PORT}/host`);
  if (lan) console.log(`  On your LAN:  http://${lan}:${config.PORT}/host`);
  if (config.PUBLIC_URL) console.log(`  Public URL:   ${config.PUBLIC_URL}/host`);
  const info = gameInfo();
  console.log(`  Categories:   ${info.online.categories.length} from ${info.online.name} + ${info.packs.length} from files`);
  for (const e of info.errors) console.warn(`  ! Skipped ${e}`);
  console.log('');
  sources.warmUp(); // fetch an Open Trivia DB session token in the background
});

function shutdown() {
  for (const game of games.values()) game.end('The server is restarting.');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
