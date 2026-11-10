// Online trivia databases. Questions are fetched live when a host opens a lobby, then normalised
// into the same shape as local packs ({ question, answers, correct, time, points, source }).
//
//  • Open Trivia DB — https://opentdb.com — CC BY-SA 4.0. One category per request, max 50
//    questions, and one request per 5 seconds per IP (we queue requests to respect that). A session
//    token stops the same question coming up twice within ~6 hours.
//  • The Trivia API — https://the-trivia-api.com — CC BY-NC 4.0 (free for non-commercial use).
//    Several categories per request, max 50 questions, 20 requests per 5 seconds.
const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const HEADERS = { 'User-Agent': 'roundtable-trivia (+https://github.com/Declan-Corco/roundtable-trivia)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Puts the right answer among the wrong ones at a random position (A-D). */
function multipleChoice(correctText, wrongTexts) {
  const answers = shuffle([correctText, ...wrongTexts.slice(0, 3)]);
  return { answers, correct: [answers.indexOf(correctText)] };
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

// ------------------------------------------------------------------ Open Trivia DB

const OTDB = {
  id: 'otdb',
  name: 'Open Trivia DB',
  url: 'https://opentdb.com',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  // id -> name (from https://opentdb.com/api_category.php; "Entertainment:"/"Science:" prefixes trimmed)
  categories: [
    [9, 'General Knowledge'], [17, 'Science & Nature'], [22, 'Geography'], [23, 'History'],
    [11, 'Film'], [14, 'Television'], [12, 'Music'], [10, 'Books'], [15, 'Video Games'],
    [21, 'Sports'], [27, 'Animals'], [18, 'Computers'], [19, 'Mathematics'], [20, 'Mythology'],
    [25, 'Art'], [26, 'Celebrities'], [24, 'Politics'], [28, 'Vehicles'], [30, 'Gadgets'],
    [16, 'Board Games'], [13, 'Musicals & Theatre'], [29, 'Comics'], [31, 'Anime & Manga'],
    [32, 'Cartoons & Animation'],
  ],
};

let otdbNextSlot = 0; // the API allows one request per 5 seconds per IP
async function otdbSlot() {
  const now = Date.now();
  const at = Math.max(now, otdbNextSlot);
  otdbNextSlot = at + 5200;
  if (at > now) await sleep(at - now);
}

let otdbToken = null;
async function otdbNewToken() {
  await otdbSlot();
  const data = await getJSON('https://opentdb.com/api_token.php?command=request');
  otdbToken = data.response_code === 0 ? data.token : null;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    return String(s).trim();
  }
};

/** Fetches `amount` questions from one Open Trivia DB category. */
async function otdbCategory(categoryId, amount, difficulty) {
  let tries = 0;
  for (;;) {
    tries++;
    const params = new URLSearchParams({ amount: String(Math.min(50, amount)), category: String(categoryId), encode: 'url3986' });
    if (difficulty) params.set('difficulty', difficulty);
    if (otdbToken) params.set('token', otdbToken);
    await otdbSlot();
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
          if (data.response_code === 4 && otdbToken) {
            await otdbSlot();
            await getJSON(`https://opentdb.com/api_token.php?command=reset&token=${otdbToken}`).catch(() => {});
          } else {
            await otdbNewToken().catch(() => (otdbToken = null));
          }
          continue;
        }
        return [];
      case 5: // rate limited (another app on this IP?) — wait and retry
        if (tries < 3) continue;
        throw new Error('it is rate-limiting this server, try again in a few seconds');
      default:
        throw new Error(`it rejected the request (code ${data.response_code})`);
    }
  }
}

function otdbNormalise(r) {
  const question = decode(r.question);
  const correctText = decode(r.correct_answer);
  const wrong = (r.incorrect_answers || []).map(decode);
  const choice =
    r.type === 'boolean'
      ? { answers: ['True', 'False'], correct: [correctText.toLowerCase() === 'true' ? 0 : 1] }
      : multipleChoice(correctText, wrong);
  return { question, ...choice, category: decode(r.category), difficulty: r.difficulty, source: OTDB.id };
}

async function fetchOtdb(categoryIds, perCategory, difficulty) {
  if (!otdbToken) await otdbNewToken().catch(() => (otdbToken = null));
  const out = [];
  for (const id of categoryIds) {
    const results = await otdbCategory(id, perCategory, difficulty);
    out.push(...results.map(otdbNormalise));
  }
  return out;
}

// ------------------------------------------------------------------ The Trivia API

const TTA = {
  id: 'tta',
  name: 'The Trivia API',
  url: 'https://the-trivia-api.com',
  license: 'CC BY-NC 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
  categories: [
    ['general_knowledge', 'General Knowledge'], ['science', 'Science'], ['history', 'History'],
    ['geography', 'Geography'], ['film_and_tv', 'Film & TV'], ['music', 'Music'],
    ['arts_and_literature', 'Arts & Literature'], ['sport_and_leisure', 'Sport & Leisure'],
    ['society_and_culture', 'Society & Culture'], ['food_and_drink', 'Food & Drink'],
  ],
};

async function fetchTta(slugs, total, difficulty) {
  const params = new URLSearchParams({ limit: String(Math.min(50, Math.max(1, total))), categories: slugs.join(',') });
  if (difficulty) params.set('difficulties', difficulty);
  const data = await getJSON(`https://the-trivia-api.com/v2/questions?${params}`);
  if (!Array.isArray(data)) throw new Error('it sent an unexpected answer');
  return data
    .filter((q) => q && q.question && q.correctAnswer && Array.isArray(q.incorrectAnswers))
    .map((q) => ({
      question: String(q.question.text || '').trim(),
      ...multipleChoice(String(q.correctAnswer).trim(), q.incorrectAnswers.map((a) => String(a).trim())),
      category: q.category,
      difficulty: q.difficulty,
      source: TTA.id,
    }));
}

// ------------------------------------------------------------------ public interface

const SOURCES = [OTDB, TTA];
const byId = new Map(SOURCES.map((s) => [s.id, s]));

/** For the host screen: each database with its categories (ids like "otdb:9", "tta:science"). */
function listSources() {
  return SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    license: s.license,
    licenseUrl: s.licenseUrl,
    categories: s.categories.map(([id, title]) => ({ id: `${s.id}:${id}`, title })),
  }));
}

/** "otdb:9" -> { source: OTDB, key: "9", title: "General Knowledge" } (or null if unknown). */
function parseCategory(id) {
  const [srcId, key] = String(id).split(':');
  const src = byId.get(srcId);
  const cat = src?.categories.find(([k]) => String(k) === key);
  return cat ? { source: src, key: cat[0], title: cat[1] } : null;
}

/**
 * Fetches questions for the chosen online categories.
 * `perCategory` = how many to fetch from each one; `difficulty` = '' | 'easy' | 'medium' | 'hard'.
 */
async function fetchOnline(categories, perCategory, difficulty) {
  const otdb = categories.filter((c) => c.source === OTDB).map((c) => c.key);
  const tta = categories.filter((c) => c.source === TTA).map((c) => c.key);
  const out = [];
  if (tta.length) {
    try {
      out.push(...(await fetchTta(tta, perCategory * tta.length, difficulty)));
    } catch (err) {
      throw new Error(`Couldn't get questions from The Trivia API: ${err.message}.`);
    }
  }
  if (otdb.length) {
    try {
      out.push(...(await fetchOtdb(otdb, perCategory, difficulty)));
    } catch (err) {
      throw new Error(`Couldn't get questions from Open Trivia DB: ${err.message}.`);
    }
  }
  return out;
}

/** Credit line shown with each online question (both licenses require attribution). */
function credit(sourceId) {
  const s = byId.get(sourceId);
  return s ? `${s.name} · ${s.license}` : null;
}

/** Gets a session token in the background at startup, so the first game doesn't wait for it. */
function warmUp() {
  otdbNewToken().catch(() => {});
}

module.exports = { listSources, parseCategory, fetchOnline, credit, warmUp };
