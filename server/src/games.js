// The games a host can pick. Each game declares its question packs (categories) and its settings;
// the host screen builds its setup page from this list, so adding a game here is all it takes.
//
// A game is played by the shared engine in game.js: a run of multiple-choice questions (A-D),
// a timer, a reveal and standings. What differs per game is where the questions come from and how
// answers score (`mode`):
//   'correct'  — points for picking a right answer (trivia)
//   'majority' — points for picking what most of the table picked (no right answers)
const crypto = require('crypto');
const config = require('./config');
const { loadSets, validateSet } = require('./trivia');

const COUNT_SETTING = (noun, def) => ({
  id: 'count',
  label: `${noun}s`,
  options: [
    { value: 5, label: '5' },
    { value: 10, label: '10' },
    { value: 15, label: '15' },
    { value: 0, label: 'All' },
  ],
  default: def,
});
/** `seconds`: the choices offered; 0 = use each question's own time. */
const TIME_SETTING = (def, seconds) => ({
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

const GAMES = [
  {
    id: 'trivia',
    name: 'Trivia',
    tagline: 'Quick-fire questions. Right and fast wins.',
    description: 'Pick one or more categories. Everyone answers A, B, C or D, and faster correct answers score more.',
    mode: 'correct',
    noun: 'Question',
    dir: () => config.TRIVIA_DIR,
    requireCorrect: true,
    settings: [COUNT_SETTING('Question', 10), TIME_SETTING(0, [0, 10, 20, 30]), ORDER_SETTING],
  },
  {
    id: 'majority',
    name: 'Majority Rules',
    tagline: 'No right answers. Pick what the table picks.',
    description: 'This-or-that questions with no right answer. You score by siding with the most popular choice.',
    mode: 'majority',
    noun: 'Question',
    dir: () => config.MAJORITY_DIR,
    requireCorrect: false,
    settings: [COUNT_SETTING('Question', 10), TIME_SETTING(15, [10, 15, 20, 30]), ORDER_SETTING],
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
      settings: g.settings.map(({ id, label, options, default: def }) => ({ id, label, options, default: def })),
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
 * Builds the round a host asked for: the chosen categories (plus an optional uploaded pack),
 * shuffled / trimmed / re-timed per the settings. Returns the game definition and the round.
 */
function buildRound({ game: gameId, packs = [], customSet, settings: rawSettings }) {
  const game = byId.get(String(gameId || 'trivia'));
  if (!game) throw new Error('That game no longer exists. Refresh the page.');
  const settings = parseSettings(game, rawSettings || {});
  const { sets } = loadPacks(game);

  const titles = [];
  let questions = [];
  for (const id of [...new Set((Array.isArray(packs) ? packs : []).map(String))]) {
    const pack = sets.get(id);
    if (!pack) throw new Error('One of those categories no longer exists. Refresh the page.');
    titles.push(pack.title);
    questions.push(...pack.questions);
  }
  if (customSet) {
    if (!config.ALLOW_UPLOADS) throw new Error('Uploading question files is disabled on this server.');
    const custom = validateSet(customSet, 'Uploaded pack', { requireCorrect: game.requireCorrect });
    titles.push(custom.title);
    questions.push(...custom.questions);
  }
  if (!questions.length) throw new Error('Pick at least one category.');

  if (settings.shuffle) shuffle(questions);
  if (settings.count) questions = questions.slice(0, settings.count);
  if (settings.time) questions = questions.map((q) => ({ ...q, time: settings.time }));

  const title = titles.length <= 2 ? titles.join(' & ') : `${titles.length} categories`;
  return { game, round: { title, questions } };
}

module.exports = { listGames, buildRound, GAMES };
