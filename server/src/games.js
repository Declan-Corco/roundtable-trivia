// The game a host sets up: trivia with bets. Before each question everyone sees its category
// and bets some of their points; a right answer wins the bet, a wrong one loses it (see game.js).
//
// Question sources:
//   online — live categories from Open Trivia DB (see sources.js)
//   packs  — .json files in server/trivia/ (see the README there), plus an optional upload
const crypto = require('crypto');
const config = require('./config');
const { loadSets, validateSet } = require('./trivia');
const sources = require('./sources');

const DEFAULT_ONLINE_COUNT = 20; // when a host picks "All" with online categories
const MAX_ROUND = 50;

const GAME = {
  name: 'Trivia',
  description:
    'Everyone starts with 1,000 points. Before each question you see its category and bet some or all of ' +
    'your points on your phone. A right answer wins the bet; a wrong one loses it. ' +
    'Questions come live from Open Trivia DB, or from your own files.',
  defaultPacks: ['otdb:9', 'otdb:11', 'otdb:21'],
  settings: [
    {
      id: 'count',
      label: 'Questions',
      options: [5, 10, 15, 20, 30].map((v) => ({ value: v, label: String(v) })),
      default: 10,
    },
    {
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
    },
    {
      id: 'wagerTime',
      label: 'Time to bet',
      options: [10, 15, 20].map((s) => ({ value: s, label: `${s}s` })),
      default: 15,
    },
    {
      id: 'time', // 0 = use each question's own time
      label: 'Time to answer',
      options: [0, 10, 20, 30].map((s) => ({ value: s, label: s ? `${s}s` : 'As written' })),
      default: 20,
    },
    {
      id: 'shuffle',
      label: 'Order',
      options: [
        { value: true, label: 'Shuffled' },
        { value: false, label: 'As written' },
      ],
      default: true,
    },
  ],
};

const loadPacks = () => loadSets(config.TRIVIA_DIR);

/** Questions from a pack, labelled with the pack's title as their category (shown before betting). */
const withCategory = (questions, title) => questions.map((q) => ({ ...q, category: q.category || title }));

/** Everything the host setup screen needs: the categories and settings. */
function gameInfo() {
  const { sets, errors } = loadPacks();
  return {
    name: GAME.name,
    description: GAME.description,
    allowUpload: config.ALLOW_UPLOADS,
    defaultPacks: GAME.defaultPacks,
    settings: GAME.settings.map(({ id, label, hint, options, default: def }) => ({ id, label, hint, options, default: def })),
    online: sources.listOnline(), // Open Trivia DB categories
    packs: [...sets.values()].map((s) => ({ id: s.id, title: s.title, description: s.description, count: s.questions.length })),
    errors,
  };
}

/** Keeps only setting values the game offers; anything else falls back to the default. */
function parseSettings(raw = {}) {
  const out = {};
  for (const s of GAME.settings) {
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
 * Returns the game, the settings and the round. Async because online questions are fetched live.
 */
async function buildRound({ packs = [], customSet, settings: rawSettings }) {
  const settings = parseSettings(rawSettings || {});
  const { sets } = loadPacks();

  const chosen = [...new Set((Array.isArray(packs) ? packs : []).map(String))];
  const online = [];
  const local = [];
  for (const id of chosen) {
    if (id.includes(':')) {
      const cat = sources.parseCategory(id);
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
    custom = validateSet(customSet, 'Uploaded pack');
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
          const [norm] = validateSet({ questions: [q] }, '').questions;
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

  const unique = [...new Set(titles)];
  const title = unique.length <= 2 ? unique.join(' & ') : `${unique.length} categories`;
  return { game: GAME, settings, round: { title, questions } };
}

module.exports = { gameInfo, buildRound, GAME };
