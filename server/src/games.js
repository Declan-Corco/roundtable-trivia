// The games a host can pick. The host screen builds its picker and setup page from this list.
//
//   Wager Wars ('wager')  — trivia with bets. Before each question everyone sees its category and bets
//                            some of their points; a right answer wins the bet, a wrong one loses it.
//                            Questions: live Open Trivia DB categories (sources.js), .json files in
//                            server/trivia/, or an uploaded file.
//   Only One ('onlyone')  — each round shows a category; tables type as many answers as they can, and
//                            only answers no other table wrote score. Prompts: .json packs in
//                            server/onlyone/, or prompts the host types in.
//   Split Decision ('split') — everyone secretly picks one of two answers ("Morning or night shower?"),
//                            then every table guesses what percent of the room picked the first one;
//                            the closer the guess, the more it scores. Questions: .json packs in
//                            server/split/, or questions the host types in.
//   Table Takedown ('takedown') — every table writes one funny answer to a prompt; the answers go up
//                            anonymously and everyone votes for the best (never their own). Votes score,
//                            the top answer wins a bonus, and voting for the winner scores too. Answers
//                            are moderated (moderate.js) for the crowd the host picks. Prompts: .json
//                            packs in server/takedown/, or prompts the host types in.
// The engine for all of them is game.js; Only One's answer matching is matcher.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { loadSets, validateSet } = require('./trivia');
const sources = require('./sources');
const moderation = require('./moderate');

const DEFAULT_ONLINE_COUNT = 20; // when a host picks "All" with online categories

/** Both games: move on from the reveal / results and the standings by itself after this long (0 = the host presses). */
const AUTO_SETTING = {
  id: 'auto',
  label: 'Move on automatically',
  hint: 'After each answer and the standings. You can still press to go sooner.',
  slider: true,
  options: [
    { value: 0, label: 'Manual' },
    { value: 10, label: '10 sec' },
    { value: 30, label: '30 sec' },
    { value: 60, label: '1 min' },
  ],
  default: 0,
};
const MAX_ROUND = 50;

const WAGER = {
  id: 'wager',
  kind: 'wager',
  unit: 'question', // what one step of the game is called on screen
  name: 'Wager Wars',
  tagline: 'See the category, bet your points, then answer.',
  description:
    'Everyone starts with 1,000 points. Before each question you see its category and bet some or all ' +
    'of your points. A right answer wins the bet; a wrong one loses it.',
  defaultPacks: () => sources.listOnline().categories.map((c) => c.id), // every category ticked to start
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
      default: 'easy',
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
    AUTO_SETTING,
  ],
};

const ONLY_ONE = {
  id: 'onlyone',
  kind: 'onlyone',
  unit: 'round',
  name: 'Only One',
  tagline: 'Name things nobody else thinks of.',
  description:
    'Each round shows a category, like "Things in a dorm room". Every table types as many answers as it can. ' +
    'Any answer another table also wrote scores nothing; answers only you thought of score 100 each.',
  defaultPacks: () => [...loadPromptPacks().packs.keys()], // every pack ticked to start
  settings: [
    {
      id: 'count',
      label: 'Rounds',
      options: [3, 5, 8, 10].map((v) => ({ value: v, label: String(v) })),
      default: 5,
    },
    {
      id: 'time',
      label: 'Time to answer',
      options: [45, 60, 90, 120].map((s) => ({ value: s, label: `${s}s` })),
      default: 60,
    },
    AUTO_SETTING,
  ],
};

const SPLIT = {
  id: 'split',
  kind: 'split',
  unit: 'round',
  name: 'Split Decision',
  tagline: 'Guess how the room splits.',
  description:
    'Everyone secretly picks a side, like "Shower: morning or night?". Then every table guesses what percent ' +
    'of the room picked the first answer. The closer the guess, the more it scores (up to 100), and the ' +
    'closest table gets a 50-point bonus.',
  defaultPacks: () => [...loadSplitPacks().packs.keys()], // every pack ticked to start
  settings: [
    {
      id: 'count',
      label: 'Rounds',
      options: [5, 8, 10, 15].map((v) => ({ value: v, label: String(v) })),
      default: 8,
    },
    {
      id: 'time',
      label: 'Time to pick a side',
      options: [10, 15, 20].map((s) => ({ value: s, label: `${s}s` })),
      default: 15,
    },
    {
      id: 'guessTime',
      label: 'Time to guess',
      options: [15, 20, 30].map((s) => ({ value: s, label: `${s}s` })),
      default: 20,
    },
    AUTO_SETTING,
  ],
};

/**
 * Table Takedown's crowd setting: how strict the filter is. A server can lock it for every host
 * with TAKEDOWN_FILTER (e.g. a school server set to "family").
 */
function crowdSetting() {
  const locked = moderation.CROWDS[config.TAKEDOWN_FILTER] ? config.TAKEDOWN_FILTER : '';
  const ids = locked ? [locked] : Object.keys(moderation.CROWDS);
  return {
    id: 'crowd',
    label: 'Crowd',
    hint: locked
      ? 'Set by this server.'
      : moderation.enabled()
        ? 'Claude checks every answer before it goes on the TV.'
        : 'A word list checks answers (add an API key for Claude to check them).',
    options: ids.map((id) => ({ value: id, label: moderation.CROWDS[id].label })),
    default: ids[0],
  };
}

const TAKEDOWN = {
  id: 'takedown',
  kind: 'takedown',
  unit: 'round',
  name: 'Table Takedown',
  tagline: 'Write the funniest answer. Win the room.',
  description:
    'Each round shows a prompt, like "A terrible name for a pet goldfish". Every table writes one answer, and the answers ' +
    'go up on the TV with no names. Everyone votes for their favourite, but not their own. Each vote is worth 100, the ' +
    'top answer gets 100 more, and voting for the winner earns you 50.',
  defaultPacks: () => [...loadPromptPacks(config.TAKEDOWN_DIR).packs.keys()],
  get settings() {
    return [
      {
        id: 'count',
        label: 'Rounds',
        options: [3, 5, 8].map((v) => ({ value: v, label: String(v) })),
        default: 5,
      },
      {
        id: 'time',
        label: 'Time to write',
        options: [45, 60, 90].map((s) => ({ value: s, label: `${s}s` })),
        default: 60,
      },
      {
        id: 'voteTime',
        label: 'Time to vote',
        options: [15, 20, 30].map((s) => ({ value: s, label: `${s}s` })),
        default: 20,
      },
      crowdSetting(),
      AUTO_SETTING,
    ];
  },
};

const GAMES = [WAGER, ONLY_ONE, SPLIT, TAKEDOWN];
const byId = new Map(GAMES.map((g) => [g.id, g]));

const MAX_PROMPT = 100;
const cleanPrompt = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);

/**
 * Prompt packs: every .json file in a folder — server/onlyone/ (Only One) or server/takedown/
 * (Table Takedown); see the README in each. Bad files are skipped.
 */
function loadPromptPacks(dir = config.ONLYONE_DIR) {
  const packs = new Map();
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    errors.push(`Cannot read folder ${dir}: ${err.message}`);
  }
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!raw || !Array.isArray(raw.prompts) || !raw.prompts.length) throw new Error('"prompts" must be a non-empty array.');
      const prompts = raw.prompts
        .map((p) => (typeof p === 'object' && p ? { prompt: cleanPrompt(p.prompt), time: Number(p.time) || 0 } : { prompt: cleanPrompt(p), time: 0 }))
        .filter((p) => p.prompt);
      if (!prompts.length) throw new Error('no usable prompts.');
      packs.set(id, {
        id,
        title: cleanPrompt(raw.title) || id,
        icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 8) : '',
        description: String(raw.description || '').slice(0, 200),
        prompts,
      });
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return { packs, errors };
}

// Split Decision: a question and its two answers. An answer is at most MAX_OPTION characters so it
// fits on a phone button and on the split bar.
const MAX_OPTION = 24;
const cleanOption = (v) => cleanPrompt(v).slice(0, MAX_OPTION);

/**
 * One Split Decision question from a pack or the host: "Question?" (a yes/no question),
 * { question, a, b }, or [question, a, b]. Returns { question, a, b } or null.
 */
function splitQuestion(raw) {
  let question;
  let a = '';
  let b = '';
  if (typeof raw === 'string') question = raw;
  else if (Array.isArray(raw)) [question, a, b] = raw;
  else if (raw && typeof raw === 'object') ({ question, a, b } = raw);
  question = cleanPrompt(question);
  a = cleanOption(a);
  b = cleanOption(b);
  if (!question) return null;
  if (!a && !b) [a, b] = ['Yes', 'No'];
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  return { question, a, b };
}

/** Split Decision packs: every .json file in server/split/ (see the README there). Bad files are skipped. */
function loadSplitPacks() {
  const packs = new Map();
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(config.SPLIT_DIR).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    errors.push(`Cannot read folder ${config.SPLIT_DIR}: ${err.message}`);
  }
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(config.SPLIT_DIR, file), 'utf8'));
      if (!raw || !Array.isArray(raw.questions) || !raw.questions.length) throw new Error('"questions" must be a non-empty array.');
      const questions = raw.questions.map(splitQuestion).filter(Boolean);
      if (!questions.length) throw new Error('no usable questions.');
      packs.set(id, {
        id,
        title: cleanPrompt(raw.title) || id,
        icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 8) : '',
        description: String(raw.description || '').slice(0, 200),
        questions,
      });
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return { packs, errors };
}

const loadPacks = () => loadSets(config.TRIVIA_DIR);

/** Questions from a pack, labelled with the pack's title as their category (shown before betting). */
const withCategory = (questions, title) => questions.map((q) => ({ ...q, category: q.category || title }));

const publicSettings = (game) => game.settings.map(({ id, label, hint, slider, options, default: def }) => ({ id, label, hint, slider: !!slider, options, default: def }));

/** Everything the host setup screen needs: the games, their categories and settings. */
function listGames() {
  const trivia = loadPacks();
  const prompts = loadPromptPacks();
  const split = loadSplitPacks();
  const takedown = loadPromptPacks(config.TAKEDOWN_DIR);
  return [
    {
      id: WAGER.id,
      kind: WAGER.kind,
      unit: WAGER.unit,
      name: WAGER.name,
      tagline: WAGER.tagline,
      description: WAGER.description,
      allowUpload: config.ALLOW_UPLOADS,
      packNoun: 'questions',
      defaultPacks: WAGER.defaultPacks(),
      settings: publicSettings(WAGER),
      online: sources.listOnline(), // Open Trivia DB categories
      packs: [...trivia.sets.values()].map((s) => ({ id: s.id, title: s.title, description: s.description, count: s.questions.length })),
      errors: trivia.errors,
    },
    {
      id: ONLY_ONE.id,
      kind: ONLY_ONE.kind,
      unit: ONLY_ONE.unit,
      name: ONLY_ONE.name,
      tagline: ONLY_ONE.tagline,
      description: ONLY_ONE.description,
      allowUpload: false,
      // The host can type their own prompts, one per line.
      customPrompts: {
        placeholder: 'Things in our group chat\nReasons Sam is late\nThings in this room',
        help: 'One per line. Your own categories are played first.',
      },
      packNoun: 'categories',
      defaultPacks: [...prompts.packs.keys()],
      settings: publicSettings(ONLY_ONE),
      online: null,
      packs: [...prompts.packs.values()].map((p) => ({ id: p.id, title: p.title, icon: p.icon, description: p.description, count: p.prompts.length })),
      errors: prompts.errors,
    },
    {
      id: SPLIT.id,
      kind: SPLIT.kind,
      unit: SPLIT.unit,
      name: SPLIT.name,
      tagline: SPLIT.tagline,
      description: SPLIT.description,
      allowUpload: false,
      customPrompts: {
        placeholder: 'Cats or dogs? | Cats | Dogs\nHave you ever been to Paris?',
        help: 'One per line: the question, then its two answers after | marks. A question on its own is yes / no. Your own questions are played first.',
      },
      packNoun: 'questions',
      defaultPacks: [...split.packs.keys()],
      settings: publicSettings(SPLIT),
      online: null,
      packs: [...split.packs.values()].map((p) => ({ id: p.id, title: p.title, icon: p.icon, description: p.description, count: p.questions.length })),
      errors: split.errors,
    },
    {
      id: TAKEDOWN.id,
      kind: TAKEDOWN.kind,
      unit: TAKEDOWN.unit,
      name: TAKEDOWN.name,
      tagline: TAKEDOWN.tagline,
      description: TAKEDOWN.description,
      allowUpload: false,
      customPrompts: {
        placeholder: 'The worst thing to say at our office party\nA new name for this bar\nWhat Sam is secretly good at',
        help: 'One per line. Your own prompts are played first.',
      },
      packNoun: 'prompts',
      defaultPacks: [...takedown.packs.keys()],
      settings: publicSettings(TAKEDOWN),
      online: null,
      packs: [...takedown.packs.values()].map((p) => ({ id: p.id, title: p.title, icon: p.icon, description: p.description, count: p.prompts.length })),
      errors: takedown.errors,
    },
  ];
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
 * Returns the game, the settings and the round. Async because online questions are fetched live.
 */
async function buildRound({ game: gameId, packs = [], customSet, customPrompts, settings: rawSettings }) {
  const game = byId.get(String(gameId || 'wager'));
  if (!game) throw new Error('That game no longer exists. Refresh the page.');
  const settings = parseSettings(game, rawSettings || {});
  if (game.kind === 'onlyone') return buildPromptRound(game, packs, customPrompts, settings);
  if (game.kind === 'split') return buildSplitRound(game, packs, customPrompts, settings);
  if (game.kind === 'takedown') {
    // Same prompts as Only One's, from their own folder, with the vote time and crowd on each round.
    const { packs: takedownPacks } = loadPromptPacks(config.TAKEDOWN_DIR);
    return buildPromptRound(game, packs, customPrompts, settings, takedownPacks, { voteTime: settings.voteTime, crowd: settings.crowd });
  }
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
  return { game, settings, round: { title, questions } };
}

/**
 * Only One / Table Takedown: `settings.count` prompts drawn from the chosen packs and/or the host's
 * own prompts. `extra` is added to every round (Table Takedown's vote time and crowd).
 */
function buildPromptRound(game, packIds, customPrompts, settings, packs = loadPromptPacks().packs, extra = {}) {
  const pool = [];
  const titles = [];
  for (const id of [...new Set((Array.isArray(packIds) ? packIds : []).map(String))]) {
    const pack = packs.get(id);
    if (!pack) throw new Error('One of those categories no longer exists. Refresh the page.');
    pool.push(...pack.prompts.map((p) => ({ ...p, category: pack.title })));
    titles.push(pack.title);
  }
  const own = (Array.isArray(customPrompts) ? customPrompts : []).map(cleanPrompt).filter(Boolean).slice(0, 50);
  if (own.length) {
    titles.push('Your own');
    // The host's own prompts go first, in the order typed; packs fill the remaining rounds.
    shuffle(pool);
    pool.unshift(...own.map((prompt) => ({ prompt, time: 0, category: 'Your own' })));
  } else {
    shuffle(pool);
  }
  if (!pool.length) throw new Error('Pick at least one category, or type your own.');
  const seen = new Set();
  const questions = [];
  for (const p of pool) {
    const key = p.prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({ question: p.prompt, category: p.category, time: p.time || settings.time, points: 'standard', answers: [], correct: [], ...extra });
    if (questions.length >= settings.count) break;
  }
  const unique = [...new Set(titles)];
  const title = unique.length <= 2 ? unique.join(' & ') : `${unique.length} packs`;
  return { game, settings, round: { title, questions } };
}

/**
 * Split Decision: `settings.count` questions drawn from the chosen packs and/or the host's own,
 * typed one per line as "Question | Answer A | Answer B" (or just "Question?" for yes / no).
 */
function buildSplitRound(game, packIds, customLines, settings) {
  const { packs } = loadSplitPacks();
  const pool = [];
  const titles = [];
  for (const id of [...new Set((Array.isArray(packIds) ? packIds : []).map(String))]) {
    const pack = packs.get(id);
    if (!pack) throw new Error('One of those question packs no longer exists. Refresh the page.');
    pool.push(...pack.questions.map((q) => ({ ...q, category: pack.title })));
    titles.push(pack.title);
  }
  shuffle(pool);
  const own = (Array.isArray(customLines) ? customLines : [])
    .slice(0, 50)
    .map((line) => {
      const [question, a = '', b = ''] = String(line ?? '').split('|');
      return splitQuestion({ question, a, b });
    })
    .filter(Boolean);
  if (own.length) {
    titles.push('Your own');
    pool.unshift(...own.map((q) => ({ ...q, category: 'Your own' }))); // played first, in the order typed
  }
  if (!pool.length) throw new Error('Pick at least one question pack, or type your own questions.');
  const seen = new Set();
  const questions = [];
  for (const q of pool) {
    const key = q.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({
      question: q.question,
      category: q.category,
      answers: [q.a, q.b],
      correct: [],
      time: settings.time, // to pick a side
      guessTime: settings.guessTime, // to guess the split
      points: 'standard',
    });
    if (questions.length >= settings.count) break;
  }
  const unique = [...new Set(titles)];
  const title = unique.length <= 2 ? unique.join(' & ') : `${unique.length} packs`;
  return { game, settings, round: { title, questions } };
}

module.exports = { listGames, buildRound, loadPromptPacks, loadSplitPacks, GAMES };
