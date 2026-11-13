// Only One: a quick local screen for answers that can't be right, run before Claude sees the round.
//
// It catches two kinds of answer, using only simple text rules (no model, no internet):
//   - nonsense: keyboard mashing ("asdfgh", "kjhgfdsa"), strings with no vowels or long runs of
//     consonants, one letter held down ("aaaaa"), a short bit repeated ("hahaha", "asdasd"), and
//     filler like "idk" or "no idea".
//   - another language: answers mostly written in another alphabet (Cyrillic, Chinese, Arabic, ...)
//     and phrases made of another language's small words ("el perro que ladra", "¿qué?").
//   - code: print("hello"), <script>, '; DROP TABLE, ${...}, x = 5 (unless the category is about coding).
// It's deliberately cautious: a single foreign word ("perro") or a borrowed phrase ("Cinco de Mayo",
// "crème de la crème") passes, and is left for Claude and the host. Some rules are switched off when
// the category itself is about words, sounds or languages ("Things grandparents say", "Languages").
// Screened answers are rejected with a reason, aren't sent to Claude, and the host can still allow them.

// Keyboard rows: 5 keys in a row on the top row (4 would catch "property", "liberty"), 4 elsewhere.
const ROWS = [
  ['qwertyuiop', 5],
  ['asdfghjkl', 4],
  ['zxcvbnm', 4],
];
const MASH = [];
for (const [row, n] of ROWS) {
  for (const r of [row, [...row].reverse().join('')]) for (let i = 0; i + n <= r.length; i++) MASH.push(r.slice(i, i + n));
}

const FILLER = new Set(
  ['idk', 'idek', 'dunno', 'i dont know', 'i do not know', 'no idea', 'not sure', 'idc', 'i dont care', 'asdf', 'blah', 'blah blah', 'lol', 'lmao', 'lmfao', 'rofl', 'xd', 'jk'].map(
    (s) => s.replace(/ /g, '')
  )
);

// Small words that are common in other languages but not English. "Weak" ones also turn up in
// phrases English borrowed ("Día de los Muertos", "crème de la crème"), so they count for half.
const STRONG = new Set(
  'que qué por para una muy pero esta este estos como cómo donde dónde porque avec dans sont qui cette vous nous je suis und mit ist nicht ich auf sie wir sind het een niet che sono questo nao não com uma você voce sim'.split(' ')
);
const WEAK = new Set('el la los las le les de del des du der das il di et y une ein eine al lo mi tu su mis sus'.split(' '));
const ENGLISH = new Set('the a an of and or to in on at for with my your you i it is that this from by not no'.split(' '));

// Categories about words or sounds, where "lol", "hahaha" or "brrr" can be real answers.
const WORDY = /\b(say|says|said|saying|sayings|text|texts|texting|slang|words?|phrases?|abbreviations?|acronyms?|sounds?|noises?|letters?|internet|memes?|excuses?|quotes?|catchphrases?|lines?|yell|shout|scream|rhymes?)\b/i;
// Code typed as an answer: print("hello"), foo(), console.log(x), <script>, ${...}, {{...}},
// '; DROP TABLE, let x = 5, a => b. (Answers like "Fresh Prince (of Bel-Air)", "Toy(s)" or
// "E = mc2" don't match.)
const CODE = [
  /[\w$]\(\s*(["'`\d]|\))/, // a call: name("..."), name(1), name()
  /[\w$]\.[\w$]+\(.*\)/, // a method call: console.log(x), document.write(x)
  /<\/?[a-z][\w-]*(\s[^>]*)?>/i, // an HTML tag
  /\$\{|\{\{|\}\}|\{\s*\}/, // template syntax
  /;\s*(drop|select|delete|insert|update|alter|exec)\b/i, // SQL after a quote or semicolon
  /--\s*$|\/\*|\*\/|^\s*\/\//, // comments
  /^\s*(var|let|const)\s+[\w$]+\s*=|^\s*(def|function)\s+[\w$]+\s*\(|^\s*#include\b/i, // declarations
  /===?|=>|&&|\|\||::|->|!=/, // operators
];
// Categories where code can be a real answer.
const CODING = /\b(cod(e|es|ing)|program(s|ming|mers?)?|software|computers?|python|javascript|html|developers?|hackers?)\b/i;

// Categories where an answer in another language can be right.
const LANGUAGES = /languag|foreign|translat|spanish|french|german|italian|japanese|chinese|korean|russian|portuguese|greek|arabic|hebrew|hindi|dutch/i;

const plain = (text) =>
  String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Why this answer can't count: 'nonsense', 'another language', 'code', or '' if it might be fine.
 * category is the round's prompt, so rules that would reject real answers there are skipped.
 */
function screen(text, category = '') {
  const raw = String(text).trim();
  const wordy = WORDY.test(category);
  const languages = LANGUAGES.test(category);

  if (!CODING.test(category) && CODE.some((re) => re.test(raw))) return 'code';

  // Another alphabet: most of the letters aren't Latin ones.
  const letters = raw.match(/\p{L}/gu) || [];
  const latin = raw.match(/\p{Script=Latin}/gu) || [];
  if (!languages && letters.length >= 2 && letters.length - latin.length > latin.length) return 'another language';

  const words = plain(raw).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const key = words.join('');
  if (!key) return '';

  // A phrase in another language: its small words are foreign ones, and none are English.
  if (!languages && words.length >= 2 && !words.some((w) => ENGLISH.has(w))) {
    let score = /[¿¡]/.test(raw) ? 1 : 0;
    for (const w of new Set(words)) score += STRONG.has(w) ? 1 : WEAK.has(w) ? 0.5 : 0;
    if (score >= 1.5) return 'another language';
  }

  if (!wordy && FILLER.has(key)) return 'nonsense';
  if (!wordy && /^\p{L}[.!?]*$/u.test(raw)) return 'nonsense'; // a single letter (not "C++", "C#")
  if (!wordy && /^(\p{L})\1{2,}$/u.test(key)) return 'nonsense'; // "aaa", "zzz" (not "ZzzQuil")

  const original = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lettersOnly = w.replace(/[^a-z]/g, '');
    if (MASH.some((m) => lettersOnly.includes(m))) return 'nonsense';
    if (/[bcdfghjklmnpqrstvwxz]{6}/.test(lettersOnly)) return 'nonsense'; // "kjhgfd" ("strengths" has 5)
    if (wordy) continue;
    if (/(\p{L})\1{4}/u.test(w)) return 'nonsense'; // "nooooo" (not "777")
    if (w.length >= 5 && /^(\p{L}{1,4})\1{2,}/u.test(w)) return 'nonsense'; // "hahaha", "asdasdasd"
    const isAcronym = original[i] && original[i] === original[i].toUpperCase();
    if (lettersOnly.length >= 5 && !/[aeiouy]/.test(lettersOnly) && !isAcronym) return 'nonsense'; // "dfgkl"
  }
  return '';
}

module.exports = { screen };
