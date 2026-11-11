// Online trivia from Open Trivia DB — https://opentdb.com — licensed CC BY-SA 4.0 (credit required).
//
// Open Trivia DB allows one request every 5 seconds per IP, and one category per request, so
// fetching questions live when a host opens a lobby took 10-15 seconds. Instead the server keeps a
// question bank: it fills up in the background (respecting that limit), is saved to disk so it
// survives restarts, and hands out questions instantly. Used questions leave the bank, so they don't
// come up again until the whole category has been played through; the bank tops itself back up
// between games. If a category runs short (say, lots of games back to back, or a difficulty with few
// questions), the rest are fetched live, as before.
//
// The bank remembers which questions it has banked or handed out, so it doesn't need Open Trivia DB's
// session tokens. Some categories are small (Animals has fewer than 100 questions): once a refill
// brings back almost nothing new, the bank has the whole category and stops asking for a while. When
// a category has been played right through, its questions come round again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const TIMEOUT_MS = 10000;
const HEADERS = { 'User-Agent': 'roundtable-trivia (+https://github.com/Declan-Corco/roundtable-trivia)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BANK_FILE = path.join(config.DATA_DIR, 'question-bank.json');
const BANK_TARGET = 100; // questions kept ready per category (mixed difficulty)
const FETCH_SIZE = 50; // the most Open Trivia DB returns per request
const MAX_USED = 3000; // per category: questions remembered as played, so they aren't banked again
const RETRY_MS = 60 * 1000; // if Open Trivia DB can't be reached, try filling the bank again after this
const FULL_MIN_NEW = 5; // a refill that finds fewer new questions than this means we have the whole category
const FULL_PAUSE_MS = 6 * 60 * 60 * 1000; // ...so don't ask about that category again for this long
const RECYCLE_AT = 20; // a fully collected category with fewer ready than this starts over (old questions return)

const SOURCE = {
  name: 'Open Trivia DB',
  url: 'https://opentdb.com',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

/**
 * The categories offered to hosts: a few popular ones. To add another, copy a line and use an id
 * from https://opentdb.com/api_category.php
 */
const CATEGORIES = [
  { id: 9, icon: '🧠', title: 'General Knowledge', description: 'A bit of everything.' },
  { id: 17, icon: '🔬', title: 'Science & Nature', description: 'Biology, chemistry, physics and the natural world.' },
  { id: 22, icon: '🌍', title: 'Geography', description: 'Countries, capitals and landmarks.' },
  { id: 23, icon: '🏛️', title: 'History', description: 'Empires, wars and famous firsts.' },
  { id: 11, icon: '🎬', title: 'Film', description: 'Movies, actors and directors.' },
  { id: 12, icon: '🎵', title: 'Music', description: 'Artists, albums and hits.' },
  { id: 21, icon: '⚽', title: 'Sports', description: 'Teams, players and records.' },
  { id: 27, icon: '🐾', title: 'Animals', description: 'Creatures great and small.' },
];
const PREFIX = 'otdb:'; // category ids as the host screen sees them, e.g. "otdb:9"

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ------------------------------------------------------------------ talking to Open Trivia DB

async function getJSON(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'it took too long to answer' : "it couldn't be reached");
  }
  if (res.status === 429) throw new Error('it is rate-limiting this server, try again in a few seconds');
  if (!res.ok) throw new Error(`it answered with an error (HTTP ${res.status})`);
  return res.json();
}

// The API allows one request per 5 seconds per IP. Requests go one at a time, each starting 5.2 s
// after the previous one *finished* (a big response can take a few seconds to arrive).
const GAP_MS = 5200;
let queue = Promise.resolve();
let lastDone = 0;
function limited(url) {
  const run = queue.then(async () => {
    const wait = lastDone + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await getJSON(url);
    } finally {
      lastDone = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    return String(s).trim();
  }
};

/** Fetches up to `amount` questions from one category. */
async function fetchCategory(categoryId, amount, difficulty) {
  let tries = 0;
  for (;;) {
    tries++;
    const params = new URLSearchParams({ amount: String(Math.min(FETCH_SIZE, amount)), category: String(categoryId), encode: 'url3986' });
    if (difficulty) params.set('difficulty', difficulty);
    const data = await limited(`https://opentdb.com/api.php?${params}`);
    switch (data.response_code) {
      case 0: // success
        return data.results;
      case 1: // not enough questions for this query: ask for fewer
        if (amount > 1 && tries < 3) {
          amount = Math.max(1, Math.floor(amount / 2));
          continue;
        }
        return [];
      case 5: // rate limited (another app on this IP?) — the queue waits, then retry
        if (tries < 3) continue;
        throw new Error('it is rate-limiting this server, try again in a few seconds');
      default:
        throw new Error(`it rejected the request (code ${data.response_code})`);
    }
  }
}

// ------------------------------------------------------------------ the question bank

/**
 * bank.categories[id] = {
 *   ready: questions waiting to be played: { key, question, correct, incorrect, type, difficulty }
 *   used:  keys of questions already handed out (oldest first), so a refill doesn't bring them back
 *   fullUntil: when the bank has the whole category, don't refill it before this time (ms)
 * }
 */
let bank = { categories: {} };
const shelf = (id) => (bank.categories[id] ||= { ready: [], used: [] });
const keyOf = (text) => crypto.createHash('sha1').update(text.toLowerCase()).digest('base64url').slice(0, 12);

function loadBank() {
  try {
    const data = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
    if (data && typeof data.categories === 'object') {
      bank = { categories: {} };
      for (const [id, c] of Object.entries(data.categories)) {
        bank.categories[id] = {
          ready: Array.isArray(c.ready) ? c.ready.filter((q) => q && q.key && q.question && q.correct) : [],
          used: Array.isArray(c.used) ? c.used.slice(-MAX_USED) : [],
          fullUntil: Number(c.fullUntil) || 0,
        };
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  ! Question bank: couldn't read ${BANK_FILE} (${err.message}); starting a new one.`);
  }
}

let saveTimer = null;
let saveWarned = false;
/** Writes the bank to disk a moment after it changes (to a temp file first, so it's never half-written). */
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(BANK_FILE), { recursive: true });
      const tmp = `${BANK_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(bank));
      fs.renameSync(tmp, BANK_FILE);
      saveWarned = false;
    } catch (err) {
      if (!saveWarned) console.warn(`  ! Question bank: couldn't save ${BANK_FILE} (${err.message}). It still works, but starts empty after a restart.`);
      saveWarned = true;
    }
  }, 1000);
  saveTimer.unref?.();
}

/** Adds fetched questions to a category's shelf, skipping ones it already has or has handed out. */
function stock(id, results) {
  const s = shelf(id);
  const known = new Set([...s.used, ...s.ready.map((q) => q.key)]);
  let added = 0;
  for (const r of results) {
    const question = decode(r.question || '');
    const correct = decode(r.correct_answer || '');
    if (!question || !correct) continue;
    const key = keyOf(question);
    if (known.has(key)) continue;
    known.add(key);
    s.ready.push({
      key,
      question,
      correct,
      incorrect: (r.incorrect_answers || []).map(decode),
      type: r.type === 'boolean' ? 'boolean' : 'multiple',
      difficulty: r.difficulty || null,
    });
    added++;
  }
  if (added) saveSoon();
  return added;
}

/** Takes up to `n` random questions off a category's shelf (of one difficulty, if asked). */
function draw(id, n, difficulty) {
  const s = shelf(id);
  const fits = s.ready.filter((q) => !difficulty || q.difficulty === difficulty);
  const picked = shuffle(fits).slice(0, n);
  if (picked.length) {
    const taken = new Set(picked.map((q) => q.key));
    s.ready = s.ready.filter((q) => !taken.has(q.key));
    s.used.push(...taken);
    if (s.used.length > MAX_USED) s.used.splice(0, s.used.length - MAX_USED);
    saveSoon();
  }
  return picked;
}

/** A banked question in the shape the game uses, with the right answer at a random position (A-D). */
function normalise(q, categoryTitle) {
  let answers;
  let correct;
  if (q.type === 'boolean') {
    answers = ['True', 'False'];
    correct = [q.correct.toLowerCase() === 'true' ? 0 : 1];
  } else {
    answers = shuffle([q.correct, ...q.incorrect.slice(0, 3)]);
    correct = [answers.indexOf(q.correct)];
  }
  return { question: q.question, answers, correct, category: categoryTitle, difficulty: q.difficulty };
}

let filling = false;
/**
 * Tops up every category's shelf to BANK_TARGET in the background, emptiest first, one request at
 * a time (see the notes at the top for small categories and starting over).
 */
async function refill() {
  if (filling) return;
  filling = true;
  let failed = null;
  const recycled = new Set(); // start a category over at most once per run
  try {
    for (;;) {
      const now = Date.now();
      // A fully collected category that has been played nearly through: its questions come round again.
      for (const c of CATEGORIES) {
        const s = shelf(c.id);
        if (s.fullUntil && s.ready.length < RECYCLE_AT && !recycled.has(c.id)) {
          recycled.add(c.id);
          s.used = [];
          s.fullUntil = 0;
          saveSoon();
        }
      }
      const next = CATEGORIES.filter((c) => shelf(c.id).ready.length < BANK_TARGET && !(shelf(c.id).fullUntil > now)).sort(
        (a, b) => shelf(a.id).ready.length - shelf(b.id).ready.length
      )[0];
      if (!next) break;
      const added = stock(next.id, await fetchCategory(next.id, FETCH_SIZE, ''));
      if (added < FULL_MIN_NEW) {
        shelf(next.id).fullUntil = Date.now() + FULL_PAUSE_MS; // we have (nearly) all of this category
        saveSoon();
      }
    }
  } catch (err) {
    failed = err;
  } finally {
    filling = false;
  }
  if (failed) {
    console.warn(`  ! Question bank: couldn't reach ${SOURCE.name} (${failed.message}). Trying again in a minute.`);
    setTimeout(refill, RETRY_MS).unref?.();
  }
}

// ------------------------------------------------------------------ public interface

/** For the host screen: the database, its license and the categories on offer. */
function listOnline() {
  return {
    ...SOURCE,
    categories: CATEGORIES.map((c) => ({ id: PREFIX + c.id, icon: c.icon, title: c.title, description: c.description })),
  };
}

/** "otdb:9" -> the category (or null if it isn't one we offer). */
function parseCategory(id) {
  const s = String(id);
  if (!s.startsWith(PREFIX)) return null;
  return CATEGORIES.find((c) => String(c.id) === s.slice(PREFIX.length)) || null;
}

/**
 * `perCategory` questions from each chosen category: from the bank, plus a live fetch for any
 * shortfall. `difficulty` = '' (mixed) | 'easy' | 'medium' | 'hard'. Returns one list per category.
 */
async function fetchOnline(categories, perCategory, difficulty) {
  const groups = [];
  let error = null;
  for (const c of categories) {
    const picked = draw(c.id, perCategory, difficulty);
    if (picked.length < perCategory) {
      try {
        const results = await fetchCategory(c.id, perCategory - picked.length + 5, difficulty);
        stock(c.id, results);
        picked.push(...draw(c.id, perCategory - picked.length, difficulty));
      } catch (err) {
        error = err;
      }
    }
    groups.push(picked.map((q) => normalise(q, c.title)));
  }
  refill(); // top the bank back up for the next game
  if (error && groups.every((g) => !g.length)) {
    throw new Error(`Couldn't get questions from ${SOURCE.name}: ${error.message}.`);
  }
  return groups;
}

/** How many questions are banked and ready, for the startup log. */
function bankStatus() {
  const now = Date.now();
  const ready = CATEGORIES.reduce((n, c) => n + shelf(c.id).ready.length, 0);
  // Done filling when every category is at its target or fully collected.
  const filling = CATEGORIES.some((c) => shelf(c.id).ready.length < BANK_TARGET && !(shelf(c.id).fullUntil > now));
  return { ready, target: BANK_TARGET * CATEGORIES.length, filling, file: BANK_FILE };
}

/** Credit line shown with each online question (the CC BY-SA license requires attribution). */
const CREDIT = `${SOURCE.name} · ${SOURCE.license}`;

/** At startup: load the saved bank and start filling it up in the background. */
function warmUp() {
  loadBank();
  refill();
}

module.exports = { listOnline, parseCategory, fetchOnline, bankStatus, CREDIT, warmUp };
