// The admin page (/admin): update the server from GitHub and change its settings, without logging
// in to it.
//
// The app runs as an unprivileged user and can do neither itself. Instead, setup.sh installs two
// small root services that systemd starts when a request file appears in data/:
//   update-request   → roundtable-update: git pull in the folder setup.sh was run from, then setup.sh again
//   settings-request → roundtable-settings: applies allowed keys to /etc/roundtable.env, then restarts
// They write their results to STATE_DIR (only root can write there; this app just reads it). All
// this module does is leave requests and read results back.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const STATE_DIR = process.env.ADMIN_STATE_DIR || '/var/lib/roundtable-admin';
const ENV_FILE = process.env.ENV_FILE || '/etc/roundtable.env';
const state = (name) => path.join(STATE_DIR, name);
const request = (name) => path.join(config.DATA_DIR, name);
const STALE_MS = 15 * 60 * 1000; // an update "running" longer than this has died

// The settings the page can change. The root service has its own copy of this list (ADMIN_KEYS in
// setup.sh) and is what really enforces it. PORT and HOST aren't here: a wrong value takes the site
// offline with no way back from the page.
const SETTINGS = [
  { key: 'PUBLIC_URL', label: 'Public address', hint: 'Used in the join QR code, e.g. https://round-table.site. Empty = detect it.' },
  { key: 'HOST_PASSWORD', label: 'Host password', secret: true, hint: 'Asked for before creating a game. Also opens this page if no update password is set.' },
  { key: 'UPDATE_PASSWORD', label: 'Admin password', secret: true, hint: 'Opens this page. Empty = use the host password.' },
  { key: 'ALLOW_UPLOADS', label: 'Trivia uploads', type: 'bool', hint: 'Hosts can upload their own trivia file.' },
  { key: 'MAX_PLAYERS', label: 'Max players per game', type: 'number', hint: 'Empty = 18.' },
  { key: 'MAX_GAMES', label: 'Max games at once', type: 'number' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, hint: 'Turns on the Claude check (Only One) and moderation (Table Takedown).' },
  { key: 'AI_CHECK_MODEL', label: 'Claude check model', hint: 'Empty = claude-haiku-5-5.' },
  { key: 'AI_CHECK_WAIT_MS', label: 'Claude check wait (ms)', type: 'number', hint: 'Empty = 20000.' },
  { key: 'MODERATION_MODEL', label: 'Moderation model', hint: 'Empty = the Claude check model.' },
  { key: 'TAKEDOWN_FILTER', label: 'Table Takedown crowd', type: 'choice', choices: ['', 'family', 'grownups', 'anything'], hint: 'Locks the crowd for every host. Empty = hosts pick.' },
  { key: 'APPLE_APP_ID', label: 'iOS app ID', hint: 'TEAMID.site.round-table.app, for opening join links in the app.' },
  { key: 'TEST_PAGE', label: 'Test page (/test)', type: 'bool', hint: 'Fake players for testing. Leave off on a public server.' },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function logTail(lines = 80) {
  try {
    // setup.sh colours its output; the page shows plain text.
    const text = fs.readFileSync(state('update.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    return text.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

/** The settings file as KEY → value (null if it can't be read, e.g. not an installed server). */
function readEnv() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return null;
  }
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/\r$/, '');
  }
  return env;
}

/** Everything the page shows: updates, settings (secrets only as set / not set) and both last results. */
function status() {
  const updater = readJson(state('updater.json'));
  let last = readJson(state('update-status.json'));
  if (last?.state === 'running' && Date.now() - Date.parse(last.at) > STALE_MS) last = { ...last, state: 'failed' };
  const env = readEnv();
  return {
    updates: {
      installed: !!updater,
      version: updater?.version || null, // the commit this server is running
      subject: updater?.subject || null,
      last, // { state: running | done | failed, at, from, to, subject }
      pending: fs.existsSync(request('update-request')) && last?.state !== 'running',
      log: logTail(),
    },
    settings: {
      available: !!env && fs.existsSync('/usr/local/sbin/roundtable-settings'),
      pending: fs.existsSync(request('settings-request')),
      last: readJson(state('settings-status.json')), // { state, at, changed: [keys], skipped }
      fields: SETTINGS.map((s) => {
        const value = env?.[s.key] ?? '';
        return { ...s, set: value !== '', value: s.secret ? '' : value };
      }),
    },
  };
}

function writeRequest(name, body) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const tmp = request(`${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, request(name)); // appears whole, so the root service never reads half a file
}

/** Asks for an update. Throws with a message for the page if it can't. */
function requestUpdate() {
  const { updates } = status();
  if (!updates.installed) throw new Error('Updating from here is not set up yet. Run the installer on the server once: git pull && sudo bash server/setup.sh');
  if (updates.last?.state === 'running' || updates.pending) throw new Error('An update is already under way.');
  writeRequest('update-request', new Date().toISOString());
}

/** Asks for settings to be changed: { KEY: value, … }. Throws with a message for the page if it can't. */
function requestSettings(changes) {
  const { settings } = status();
  if (!settings.available) throw new Error('Changing settings from here is not set up yet. Run the installer on the server once: git pull && sudo bash server/setup.sh');
  if (settings.pending) throw new Error('A settings change is already being applied.');
  const lines = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const field = BY_KEY.get(key);
    if (!field) throw new Error(`${key} can't be changed from here.`);
    const value = String(raw ?? '').trim();
    if (/[\r\n]/.test(value) || value.endsWith('\\')) throw new Error(`${field.label}: that value can't be saved.`);
    if (value.length > 500) throw new Error(`${field.label} is too long.`);
    if (field.type === 'number' && value && !/^\d+$/.test(value)) throw new Error(`${field.label} must be a whole number.`);
    if (field.type === 'bool' && value && !['true', 'false'].includes(value)) throw new Error(`${field.label} must be true or false.`);
    if (field.type === 'choice' && !field.choices.includes(value)) throw new Error(`${field.label}: pick one of the options.`);
    if (key === 'PUBLIC_URL' && value && !/^https?:\/\/[^\s/]+/.test(value)) throw new Error('Public address must start with http:// or https://');
    lines.push(`${key} ${Buffer.from(value, 'utf8').toString('base64')}`);
  }
  if (!lines.length) throw new Error('Nothing to change.');
  writeRequest('settings-request', lines.join('\n') + '\n');
}

module.exports = { status, requestUpdate, requestSettings };
