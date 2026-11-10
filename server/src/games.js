// The games a host can pick. Each game declares where its questions come from and its settings;
// the host screen builds its setup page from this list, so adding a game here is all it takes.
//
// A game is played by the shared engine in game.js: a run of questions, a timer, a reveal and
// standings. What differs per game is where the questions come from and how answers score (`mode`):
//   'correct'  — points for picking a right answer, faster scores more (Trivia)
//   'majority' — points for picking what most of the table picked (Majority Rules)
//   'wager'    — see the category, bet some of your points, then answer: win or lose the bet (Wager Wars)
//   'split'    — pick A or B, then guess what % of the room picked A; closest guess wins (Split Decision)
//   'closest'  — type a number; closest without going over wins (Sticker Shock)
//
// Question sources:
//   packs   — .json files in the game's folder on this server (see the README in each folder)
//   online  — live categories from Open Trivia DB (see sources.js); trivia games only
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
  hint: "Doesn't apply to your own question files",
  options: [
    { value: 'any', label: 'Mixed' },
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
  ],
  default: 'any',
};

const WAGER_TIME_SETTING = {
  id: 'wagerTime',
  label: 'Time to bet',
  options: [10, 15, 20].map((s) => ({ value: s, label: `${s}s` })),
  default: 15,
};

// `stat` names what `correctCount` means on the final screens ("7/10 correct").
// `packOptions` are the rules this game's .json packs must follow (see validateSet in trivia.js).
const GAMES = [
  {
    id: 'trivia',
    name: 'Trivia',
    tagline: 'Quick-fire questions. Right and fast wins.',
    description:
      'Pick one or more categories. Questions come live from Open Trivia DB, or from your own files. ' +
      'Everyone answers A, B, C or D, and faster correct answers score more.',
    mode: 'correct',
    stat: 'correct',
    dir: () => config.TRIVIA_DIR,
    packOptions: { requireCorrect: true },
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
    stat: 'with the table',
    dir: () => config.MAJORITY_DIR,
    packOptions: { requireCorrect: false },
    online: false,
    defaultPacks: [],
    settings: [countSetting([5, 10, 15, 0], 10), timeSetting([10, 15, 20, 30], 15), ORDER_SETTING],
  },
  {
    id: 'wager',
    name: 'Wager Wars',
    tagline: 'See the category, bet your points, then answer.',
    description:
      'Trivia with bets. Everyone starts with 1,000 points. Before each question you see its category and bet ' +
      'some or all of your points on your phone. A right answer wins the bet; a wrong one loses it.',
    mode: 'wager',
    stat: 'correct',
    dir: () => config.TRIVIA_DIR,
    packOptions: { requireCorrect: true },
    online: true,
    defaultPacks: ['otdb:9', 'otdb:11', 'otdb:21'],
    settings: [
      countSetting([5, 10, 15, 20], 10),
      DIFFICULTY_SETTING,
      WAGER_TIME_SETTING,
      timeSetting([0, 10, 20, 30], 20),
      ORDER_SETTING,
    ],
  },
  {
    id: 'split',
    name: 'Split Decision',
    tagline: 'Pick a side, then guess how the room split.',
    description:
      'Everyone votes A or B, then guesses what percentage of the room picked A. ' +
      'The closer your guess, the more you score. The closest guess gets a bonus.',
    mode: 'split',
    stat: 'closest',
    dir: () => config.SPLIT_DIR,
    packOptions: { requireCorrect: false, answerCount: 2 },
    online: false,
    defaultPacks: [],
    settings: [countSetting([5, 10, 15, 0], 10), timeSetting([15, 20, 30], 20), ORDER_SETTING],
  },
  {
    id: 'sticker',
    name: 'Sticker Shock',
    tagline: 'Guess the price. Closest without going over.',
    description:
      'Everyone types a price on their phone. The closest guess that is not over the real price wins. ' +
      'Guesses under the price also score, the closer the better. Going over scores nothing.',
    mode: 'closest',
    stat: 'won',
    dir: () => config.PRICES_DIR,
    packOptions: { kind: 'number' },
    online: false,
    defaultPacks: [],
    settings: [countSetting([5, 10, 15, 0], 10), timeSetting([20, 30, 45], 30), ORDER_SETTING],
  },
];

const byId = new Map(GAMES.map((g) => [g.id, g]));

function loadPacks(game) {
  return loadSets(game.dir(), game.packOptions);
}

/** Questions from a pack, labelled with the pack's title as their category (shown in Wager Wars). */
const withCategory = (questions, title) => questions.map((q) => ({ ...q, category: q.category || title }));

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
      online: g.online ? sources.listOnline() : null, // Open Trivia DB categories (trivia only)
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
 * Builds the round a host asked for: the chosen categories — Open Trivia DB, files on this
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
    custom = validateSet(customSet, 'Uploaded pack', game.packOptions);
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
    for (const list of fetched) {
      const valid = [];
      for (const q of list) {
        try {
          const [norm] = validateSet({ questions: [q] }, '', { requireCorrect: true }).questions;
          // The credit is shown on the host screen with the question (license attribution).
          valid.push({ ...norm, credit: sources.CREDIT, difficulty: q.difficulty });
        } catch {
          /* skip a malformed question from the API */
        }
      }
      if (valid.length) groups.push(valid);
    }
    if (!groups.length && !local.length && !custom) {
      throw new Error('Open Trivia DB returned no questions for those choices. Try another category or difficulty.');
    }
    titles.push(...online.map((c) => c.title));
  }
  for (const pack of local) {
    groups.push(withCategory(pack.questions, pack.title));
    titles.push(pack.title);
  }
  if (custom) {
    groups.push(withCategory(custom.questions, custom.title));
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
  return { game, settings, round: { title, questions } };
}

module.exports = { listGames, buildRound, GAMES };
