// All settings can be overridden with environment variables.
// On Linux installs these live in /etc/roundtable.env (created by setup.sh).
const path = require('path');

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  // Port the web server listens on.
  PORT: int('PORT', 3000),
  // Interface to bind. 0.0.0.0 = reachable from other devices on your network.
  HOST: process.env.HOST || '0.0.0.0',
  // Public address used in the QR code / join link, e.g. https://trivia.example.com
  // Leave empty to auto-detect from the address the host screen was opened with.
  PUBLIC_URL: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  // Folder containing trivia set .json files (re-scanned every time the host screen loads).
  TRIVIA_DIR: process.env.TRIVIA_DIR || path.join(__dirname, '..', 'trivia'),
  // Folder containing Only One category packs.
  ONLYONE_DIR: process.env.ONLYONE_DIR || path.join(__dirname, '..', 'onlyone'),
  // Folder for files the server writes itself, e.g. the Open Trivia DB question bank.
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // Folder containing the website frontend.
  CLIENT_DIR: process.env.CLIENT_DIR || path.join(__dirname, '..', '..', 'client'),
  // Allow hosts to upload a trivia .json file from their own computer.
  ALLOW_UPLOADS: process.env.ALLOW_UPLOADS !== 'false',
  // If set, the host screen asks for this password before creating a game.
  // Recommended when the site is public on the internet.
  HOST_PASSWORD: process.env.HOST_PASSWORD || '',
  // iOS app ID(s) allowed to open join links straight from the Camera (universal links),
  // as TEAMID.bundle.id, comma-separated. Example: ABCDE12345.site.round-table.app
  APPLE_APP_IDS: (process.env.APPLE_APP_ID || process.env.APPLE_APP_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Only One: Claude double-checks each round's answers when this key is set (optional).
  // Get one at https://console.anthropic.com. Answers are sent to Anthropic; ~$0.0005-0.001 per round.
  ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY || '').trim(),
  AI_CHECK_MODEL: process.env.AI_CHECK_MODEL || 'claude-haiku-5-5',
  // The grading screen waits this long for Claude, then shows the results without its check.
  AI_CHECK_WAIT_MS: int('AI_CHECK_WAIT_MS', 20000),
  MAX_PLAYERS: int('MAX_PLAYERS', 200),
  MAX_GAMES: int('MAX_GAMES', 50),
};
