// Loads and validates question packs (trivia sets, Majority Rules / Split Decision / Sticker Shock
// packs). A pack is a JSON file — see the README in each game's folder. Each game says which rules
// its packs follow (see `packOptions` in games.js).
const fs = require('fs');
const path = require('path');

const MAX_QUESTIONS = 200;
const POINT_MODES = ['standard', 'double', 'none'];
const MAX_NUMBER = 1e12; // largest numeric answer (Sticker Shock)

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, maxLen) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const isNumberLike = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');

/**
 * Validates raw (parsed JSON) question data and returns a normalised set.
 * Throws an Error with a human-readable message if the data is invalid.
 *
 * Options:
 *   requireCorrect — each question must say which answer is right (trivia)
 *   answerCount    — each question must have exactly this many answers (Split Decision: 2)
 *   kind           — 'choice' (answers A-D) or 'number' (a numeric "answer", e.g. a price)
 */
function validateSet(raw, fallbackTitle = 'Untitled set', { requireCorrect = true, answerCount = null, kind = 'choice' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A question pack must be a JSON object with a "questions" array.');
  }
  const defaultTime = clampInt(raw.defaultTime, 5, 240, 20);
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    throw new Error('"questions" must be a non-empty array.');
  }
  if (raw.questions.length > MAX_QUESTIONS) {
    throw new Error(`Too many questions (max ${MAX_QUESTIONS}).`);
  }
  // Number packs can set a unit for every question, e.g. "prefix": "$", "suffix": "billion".
  const packPrefix = cleanText(raw.prefix, 8);
  const packSuffix = cleanText(raw.suffix, 24);

  const questions = raw.questions.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== 'object') throw new Error(`Question ${n}: must be an object.`);
    const text = cleanText(q.question, 300);
    if (!text) throw new Error(`Question ${n}: missing "question" text.`);

    const image =
      typeof q.image === 'string' && /^(https:\/\/|\/media\/)/i.test(q.image.trim())
        ? q.image.trim().slice(0, 500)
        : null;
    const common = {
      question: text,
      time: clampInt(q.time, 5, 240, defaultTime),
      points: POINT_MODES.includes(q.points) ? q.points : 'standard',
      image,
      category: cleanText(q.category, 60) || null, // shown before betting in Wager Wars
      note: cleanText(q.note, 200) || null, // shown with the answer, e.g. "Apple's launch price, 2007"
    };

    if (kind === 'number') {
      const answer = Number(q.answer);
      if (!isNumberLike(q.answer) || !Number.isFinite(answer) || answer < 0 || answer > MAX_NUMBER) {
        throw new Error(`Question ${n}: "answer" must be a number, 0 or more.`);
      }
      return {
        ...common,
        answers: [],
        correct: [],
        answer,
        prefix: q.prefix != null ? cleanText(q.prefix, 8) : packPrefix,
        suffix: q.suffix != null ? cleanText(q.suffix, 24) : packSuffix,
      };
    }

    if (answerCount && (!Array.isArray(q.answers) || q.answers.length !== answerCount)) {
      throw new Error(`Question ${n}: "answers" must contain exactly ${answerCount} entries.`);
    }
    if (!Array.isArray(q.answers) || q.answers.length < 2 || q.answers.length > 4) {
      throw new Error(`Question ${n}: "answers" must contain 2 to 4 entries.`);
    }
    const answers = q.answers.map((a) => cleanText(a, 120));
    if (answers.some((a) => !a)) throw new Error(`Question ${n}: answers cannot be empty.`);

    let correct = [];
    if (requireCorrect) {
      const rawCorrect = Array.isArray(q.correct) ? q.correct : [q.correct];
      correct = [...new Set(rawCorrect.map(Number))];
      if (!correct.length || correct.some((c) => !Number.isInteger(c) || c < 0 || c >= answers.length)) {
        throw new Error(
          `Question ${n}: "correct" must be the index of the right answer (0-${answers.length - 1}), or an array of indexes.`
        );
      }
    }

    return { ...common, answers, correct };
  });

  return {
    title: cleanText(raw.title, 80) || fallbackTitle,
    description: cleanText(raw.description, 300),
    questions,
  };
}

/** Reads every *.json file in a pack folder. Invalid files are skipped and reported. */
function loadSets(dir, options = {}) {
  const sets = new Map();
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (err) {
    errors.push(`Cannot read folder ${dir}: ${err.message}`);
  }
  for (const file of files.sort()) {
    const id = path.basename(file, path.extname(file));
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      sets.set(id, { id, ...validateSet(raw, id, options) });
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return { sets, errors };
}

module.exports = { loadSets, validateSet, MAX_NUMBER };
