// The games a host can pick. Each game declares where its questions come from and its settings;
// the host screen builds its setup page from this list, so adding a game here is all it takes.
//
// A game is played by the shared engine in game.js: a run of multiple-choice questions (A-D),
// a timer, a reveal and standings. What differs per game is where the questions come from and how
// answers score (`mode`):
//   'correct'  — points for picking a right answer (trivia)
//   'majority' — points for picking what most of the table picked (no right answers)
//
// Question sources:
//   packs   — .json files in the game's folder on this server (see trivia/README.md)
//   online  — live trivia databases (see sources.js); trivia only
const crypto = require('crypto');
const config = require('./config');
const { loadSets, validateSet } = require('./trivia');
const sources = require('./sources');

const DEFAULT_ONLINE_COUNT = 20; // when a host picks "All" with online categories
const MAX_ROUND = 50;

const countSetting = (values, def) => ({
  id: 'count',
  label: 'Questions',
  options: values.map((v) => ({ value: v, label: v ? String(v) : 'All' })),
  default: def,
});
/** `seconds`: the choices offered; 0 = use each question's own time. */
const timeSetting = (seconds, def) => ({
  id: 'time',
  label: 'Time to answer',
  options: seconds.map((s) => ({ value: s, label: s ? `${s}s` : 'As written' })),
  default: def,
});
const ORDER_SETTING = {
  id: 'shuffle',
  label: 'Order',
  options: [
    { value: true, label: 'Shuffled' },
    { value: false, label: 'As written' },
  ],
  default: true,
};
const DIFFICULTY_SETTING = {
  id: 'difficulty',
  label: 'Difficulty',
  hint: 'Online categories only',
  options: [
    { value: 'any', label: 'Mixed' },
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
  ],
  default: 'any',
};

const GAMES = [
  {
    id: 'trivia',
    name: 'Trivia',
    tagline: 'Quick-fire questions. Right and fast wins.',
    description:
      'Pick one or more categories from the online trivia databases, or your own question files. ' +
      'Everyone answers A, B, C or D, and faster correct answers score more.',
    mode: 'correct',
    dir: () => config.TRIVIA_DIR,
    requireCorrect: true,
    online: true,
    defaultPacks: ['otdb:9'],
    settings: [countSetting([5, 10, 15, 20, 30], 10), DIFFICULTY_SETTING, timeSetting([0, 10, 20, 30], 20), ORDER_SETTING],
  },
  {
    id: 'majority',
    name: 'Majority Rules',
    tagline: 'No right answers. Pick what the table picks.',
    description: 'This-or-that questions with no right answer. You score by siding with the most popular choice.',
    mode: 'majority',
    dir: () => config.MAJORITY_DIR,
    requireCorrect: false,
    online: false,
    defaultPacks: [],
    settings: [countSetting([5, 10, 15, 0], 10), timeSetting([10, 15, 20, 30], 15), ORDER_SETTING],
  },
];

const byId = new Map(GAMES.map((g) => [g.id, g]));

function loadPacks(game) {
  return loadSets(game.dir(), { requireCorrect: game.requireCorrect });
}

/** Everything the host setup screen needs: games, their categories and settings. */
function listGames() {
  return GAMES.map((g) => {
    const { sets, errors } = loadPacks(g);
    return {
      id: g.id,
      name: g.name,
      tagline: g.tagline,
      description: g.description,
      mode: g.mode,
      allowUpload: config.ALLOW_UPLOADS,
      defaultPacks: g.defaultPacks,
      settings: g.settings.map(({ id, label, hint, options, default: def }) => ({ id, label, hint, options, default: def })),
      online: g.online ? sources.listSources() : [],
      packs: [...sets.values()].map((s) => ({ id: s.id, title: s.title, description: s.description, count: s.questions.length })),
      errors,
    };
  });
}

/** Keeps only setting values the game offers; anything else falls back to the default. */
function parseSettings(game, raw = {}) {
  const out = {};
  for (const s of game.settings) {
    const match = s.options.find((o) => o.value === raw[s.id]);
    out[s.id] = match ? match.value : s.default;
  }
  return out;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Builds the round a host asked for: the chosen categories — online databases, files on this
 * server and/or an uploaded file — shuffled / trimmed / re-timed per the settings.
 * Returns the game definition and the round. Async because online questions are fetched live.
 */
async function buildRound({ game: gameId, packs = [], customSet, settings: rawSettings }) {
  const game = byId.get(String(gameId || 'trivia'));
  if (!game) throw new Error('That game no longer exists. Refresh the page.');
  const settings = parseSettings(game, rawSettings || {});
  const { sets } = loadPacks(game);

  const chosen = [...new Set((Array.isArray(packs) ? packs : []).map(String))];
  const online = [];
  const local = [];
  for (const id of chosen) {
    if (id.includes(':')) {
      const cat = game.online ? sources.parseCategory(id) : null;
      if (!cat) throw new Error('One of those categories no longer exists. Refresh the page.');
      online.push(cat);
    } else {
      const pack = sets.get(id);
      if (!pack) throw new Error('One of those categories no longer exists. Refresh the page.');
      local.push(pack);
    }
  }

  let custom = null;
  if (customSet) {
    if (!config.ALLOW_UPLOADS) throw new Error('Uploading question files is disabled on this server.');
    custom = validateSet(customSet, 'Uploaded pack', { requireCorrect: game.requireCorrect });
  }
  const groupCount = online.length + local.length + (custom ? 1 : 0);
  if (!groupCount) throw new Error('Pick at least one category.');

  const target = Math.min(MAX_ROUND, settings.count || (online.length ? DEFAULT_ONLINE_COUNT : Infinity));
  const groups = []; // one list of questions per chosen category, so each gets a fair share
  const titles = [];

  if (online.length) {
    // Share the round between the chosen categories, then top up when everything is mixed.
    const perCategory = Math.max(1, Math.min(50, Math.ceil(target / groupCount)));
    const difficulty = settings.difficulty && settings.difficulty !== 'any' ? settings.difficulty : '';
    const fetched = await sources.fetchOnline(online, perCategory, difficulty);
    const byCategory = new Map();
    for (const q of fetched) {
      try {
        const [norm] = validateSet({ questions: [q] }, '', { requireCorrect: true }).questions;
        const key = `${q.source}:${q.category}`;
        if (!byCategory.has(key)) byCategory.set(key, []);
        // The credit is shown on the host screen with the question (license attribution).
        byCategory.get(key).push({ ...norm, credit: sources.credit(q.source) });
      } catch {
        /* skip a malformed question from the API */
      }
    }
    if (!byCategory.size && !local.length && !custom) {
      throw new Error('The trivia databases returned no questions for those choices. Try another category or difficulty.');
    }
    groups.push(...byCategory.values());
    titles.push(...online.map((c) => c.title));
  }
  for (const pack of local) {
    groups.push([...pack.questions]);
    titles.push(pack.title);
  }
  if (custom) {
    groups.push([...custom.questions]);
    titles.push(custom.title);
  }

  let questions;
  if (settings.shuffle) {
    // Take from each category in turn so they're all represented, then shuffle the result.
    groups.forEach(shuffle);
    questions = [];
    for (let i = 0; questions.length < target && groups.some((g) => i < g.length); i++) {
      for (const g of groups) if (i < g.length && questions.length < target) questions.push(g[i]);
    }
    shuffle(questions);
  } else {
    questions = groups.flat();
    if (Number.isFinite(target)) questions = questions.slice(0, target);
  }
  if (settings.time) questions = questions.map((q) => ({ ...q, time: settings.time }));
  if (!questions.length) throw new Error('No questions were found for those choices.');

  const title = [...new Set(titles)].length <= 2 ? [...new Set(titles)].join(' & ') : `${new Set(titles).size} categories`;
  return { game, round: { title, questions } };
}

module.exports = { listGames, buildRound, GAMES };
