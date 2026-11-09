// Loads and validates trivia sets. A trivia set is a JSON file — see trivia/README.md.
const fs = require('fs');
const path = require('path');

const MAX_QUESTIONS = 200;
const POINT_MODES = ['standard', 'double', 'none'];

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

/**
 * Validates raw (parsed JSON) trivia data and returns a normalised set.
 * Throws an Error with a human-readable message if the data is invalid.
 */
function validateSet(raw, fallbackTitle = 'Untitled set') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A trivia set must be a JSON object with a "questions" array.');
  }
  const defaultTime = clampInt(raw.defaultTime, 5, 240, 20);
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    throw new Error('"questions" must be a non-empty array.');
  }
  if (raw.questions.length > MAX_QUESTIONS) {
    throw new Error(`Too many questions (max ${MAX_QUESTIONS}).`);
  }

  const questions = raw.questions.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== 'object') throw new Error(`Question ${n}: must be an object.`);
    const text = cleanText(q.question, 300);
    if (!text) throw new Error(`Question ${n}: missing "question" text.`);
    if (!Array.isArray(q.answers) || q.answers.length < 2 || q.answers.length > 4) {
      throw new Error(`Question ${n}: "answers" must contain 2 to 4 entries.`);
    }
    const answers = q.answers.map((a) => cleanText(a, 120));
    if (answers.some((a) => !a)) throw new Error(`Question ${n}: answers cannot be empty.`);

    const rawCorrect = Array.isArray(q.correct) ? q.correct : [q.correct];
    const correct = [...new Set(rawCorrect.map(Number))];
    if (!correct.length || correct.some((c) => !Number.isInteger(c) || c < 0 || c >= answers.length)) {
      throw new Error(
        `Question ${n}: "correct" must be the index of the right answer (0-${answers.length - 1}), or an array of indexes.`
      );
    }

    const image =
      typeof q.image === 'string' && /^(https:\/\/|\/media\/)/i.test(q.image.trim())
        ? q.image.trim().slice(0, 500)
        : null;

    return {
      question: text,
      answers,
      correct,
      time: clampInt(q.time, 5, 240, defaultTime),
      points: POINT_MODES.includes(q.points) ? q.points : 'standard',
      image,
    };
  });

  return {
    title: cleanText(raw.title, 80) || fallbackTitle,
    description: cleanText(raw.description, 300),
    questions,
  };
}

/** Reads every *.json file in the trivia folder. Invalid files are skipped and reported. */
function loadSets(dir) {
  const sets = new Map();
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (err) {
    errors.push(`Cannot read trivia folder ${dir}: ${err.message}`);
  }
  for (const file of files.sort()) {
    const id = path.basename(file, path.extname(file));
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      sets.set(id, { id, ...validateSet(raw, id) });
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return { sets, errors };
}

module.exports = { loadSets, validateSet };
