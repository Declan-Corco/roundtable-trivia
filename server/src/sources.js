// Online trivia from Open Trivia DB — https://opentdb.com — licensed CC BY-SA 4.0 (credit required).
// Questions are fetched live when a host opens a lobby, then normalised into the same shape as
// local packs ({ question, answers, correct, time, points }).
//
// API limits: one category per request, max 50 questions, and one request per 5 seconds per IP
// (requests are queued to respect that). A session token stops the same question coming up twice
// within ~6 hours.
const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const HEADERS = { 'User-Agent': 'roundtable-trivia (+https://github.com/Declan-Corco/roundtable-trivia)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  { id: 9, title: 'General Knowledge', description: 'A bit of everything.' },
  { id: 17, title: 'Science & Nature', description: 'Biology, chemistry, physics and the natural world.' },
  { id: 22, title: 'Geography', description: 'Countries, capitals and landmarks.' },
  { id: 23, title: 'History', description: 'Empires, wars and famous firsts.' },
  { id: 11, title: 'Film', description: 'Movies, actors and directors.' },
  { id: 12, title: 'Music', description: 'Artists, albums and hits.' },
  { id: 21, title: 'Sports', description: 'Teams, players and records.' },
  { id: 27, title: 'Animals', description: 'Creatures great and small.' },
];
const PREFIX = 'otdb:'; // category ids as the host screen sees them, e.g. "otdb:9"

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

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

let nextSlot = 0; // the API allows one request per 5 seconds per IP
async function slot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 5200;
  if (at > now) await sleep(at - now);
}

let token = null;
async function newToken() {
  await slot();
  const data = await getJSON('https://opentdb.com/api_token.php?command=request');
  token = data.response_code === 0 ? data.token : null;
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
    const params = new URLSearchParams({ amount: String(Math.min(50, amount)), category: String(categoryId), encode: 'url3986' });
    if (difficulty) params.set('difficulty', difficulty);
    if (token) params.set('token', token);
    await slot();
    const data = await getJSON(`https://opentdb.com/api.php?${params}`);
    switch (data.response_code) {
      case 0: // success
        return data.results;
      case 1: // not enough questions for this query: ask for fewer
        if (amount > 1 && tries < 3) {
          amount = Math.max(1, Math.floor(amount / 2));
          continue;
        }
        return [];
      case 3: // token not found (expired)
      case 4: // token used up: every question for this query has been seen
        if (tries < 3) {
          if (data.response_code === 4 && token) {
            await slot();
            await getJSON(`https://opentdb.com/api_token.php?command=reset&token=${token}`).catch(() => {});
          } else {
            await newToken().catch(() => (token = null));
          }
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

function normalise(r, categoryTitle) {
  const question = decode(r.question);
  const correctText = decode(r.correct_answer);
  let answers;
  let correct;
  if (r.type === 'boolean') {
    answers = ['True', 'False'];
    correct = [correctText.toLowerCase() === 'true' ? 0 : 1];
  } else {
    // Put the right answer among the wrong ones at a random position (A-D).
    answers = shuffle([correctText, ...(r.incorrect_answers || []).map(decode).slice(0, 3)]);
    correct = [answers.indexOf(correctText)];
  }
  return { question, answers, correct, category: categoryTitle };
}

// ------------------------------------------------------------------ public interface

/** For the host screen: the database, its license and the categories on offer. */
function listOnline() {
  return {
    ...SOURCE,
    categories: CATEGORIES.map((c) => ({ id: PREFIX + c.id, title: c.title, description: c.description })),
  };
}

/** "otdb:9" -> the category (or null if it isn't one we offer). */
function parseCategory(id) {
  const s = String(id);
  if (!s.startsWith(PREFIX)) return null;
  return CATEGORIES.find((c) => String(c.id) === s.slice(PREFIX.length)) || null;
}

/**
 * Fetches `perCategory` questions from each chosen category.
 * `difficulty` = '' (mixed) | 'easy' | 'medium' | 'hard'. Returns one list per category.
 */
async function fetchOnline(categories, perCategory, difficulty) {
  try {
    if (!token) await newToken().catch(() => (token = null));
    const groups = [];
    for (const c of categories) {
      const results = await fetchCategory(c.id, perCategory, difficulty);
      groups.push(results.map((r) => normalise(r, c.title)));
    }
    return groups;
  } catch (err) {
    throw new Error(`Couldn't get questions from ${SOURCE.name}: ${err.message}.`);
  }
}

/** Credit line shown with each online question (the CC BY-SA license requires attribution). */
const CREDIT = `${SOURCE.name} · ${SOURCE.license}`;

/** Gets a session token in the background at startup, so the first game doesn't wait for it. */
function warmUp() {
  newToken().catch(() => {});
}

module.exports = { listOnline, parseCategory, fetchOnline, CREDIT, warmUp };
