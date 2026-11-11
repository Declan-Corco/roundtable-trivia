// Only One: decides which typed answers count as "the same answer".
//
// Two layers, both on this server (no internet needed once the model is downloaded):
//   1. Text rules: case, punctuation, spacing, plurals and small typos
//      ("Mini fridge" = "minifridge", "Microwaves" = "microwve").
//   2. A small embedding model (bge-small-en-v1.5, ~34 MB, runs on the CPU in a few dozen ms per
//      round) that scores how close two answers are in meaning ("Keurig" = "coffee maker",
//      "TV" = "television", "couch" = "sofa").
// It gets most calls right; the host fixes the rest on the review screen before anything is scored.
// If the model can't be loaded (e.g. no internet on the very first start), the rules still work.
const path = require('path');
const config = require('./config');

const MODEL = 'Xenova/bge-small-en-v1.5';
const SAME_MEANING = 0.89; // cosine similarity at or above which two answers are grouped (tuned on test pairs)

let embedder = null;
let loading = null;
let warned = false;

/** Loads the model once (downloads it into the data folder the first time). */
function loadModel() {
  if (embedder) return Promise.resolve(embedder);
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(config.DATA_DIR, 'models');
      embedder = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
      return embedder;
    })().catch((err) => {
      loading = null; // try again next round
      if (!warned) console.warn(`  ! Only One: couldn't load the answer-matching model (${err.message}). Matching by spelling only for now.`);
      warned = true;
      return null;
    });
  }
  return loading;
}

// ------------------------------------------------------------------ layer 1: text rules

const singular = (w) =>
  w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && /(s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1)
  : w.length === 3 && /^[^aeiou\d][^aeiou\d]s$/.test(w) ? w.slice(0, -1) // TVs, CDs, PCs (not "gas", "bus")
  : w;

/** "The Mini-Fridges!" -> "mini fridge" */
function normalise(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w, i, all) => !(i === 0 && all.length > 1 && /^(a|an|the|some|my)$/.test(w)))
    .map(singular)
    .join(' ');
}
const compact = (s) => s.replace(/ /g, '');

/** Damerau-Levenshtein distance (a swap of two letters counts as one edit). */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/** Same word with a typo? One slip allowed from 5 letters, two from 9. */
function typo(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5 || Math.abs(a.length - b.length) > 2) return false;
  return editDistance(a, b) <= (n >= 9 ? 2 : 1);
}

/** The key an answer is compared by (for "you already wrote that" on the phone). */
const keyOf = (text) => compact(normalise(text));

// ------------------------------------------------------------------ grouping

/**
 * Groups answers that mean the same thing.
 * entries: [{ id, text }] — every answer from every table this round.
 * Returns groups as arrays of entry ids.
 */
async function group(entries, category) {
  // Layer 1: answers with the same key, or a typo apart, start in the same group.
  const groups = []; // { ids: [], keys: Set, text }
  for (const e of entries) {
    const key = keyOf(e.text);
    if (!key) continue;
    const g = groups.find((x) => x.keys.has(key) || [...x.keys].some((k) => typo(k, key)));
    if (g) {
      g.ids.push(e.id);
      g.keys.add(key);
    } else {
      groups.push({ ids: [e.id], keys: new Set([key]), text: normalise(e.text) });
    }
  }
  if (groups.length < 2) return groups.map((g) => g.ids);

  // Layer 2: merge groups whose meanings are close, closest pair first.
  const model = await loadModel();
  if (!model) return groups.map((g) => g.ids);
  const context = String(category || '').trim().toLowerCase();
  const out = await model(
    groups.map((g) => (context ? `${g.text} (${context})` : g.text)),
    { pooling: 'mean', normalize: true }
  );
  const dim = out.dims[out.dims.length - 1];
  const vectors = groups.map((_, i) => Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
  let clusters = groups.map((g, i) => ({ ids: [...g.ids], vecs: [vectors[i]] }));
  const cosine = (a, b) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / Math.sqrt(na * nb);
  };
  // Two groups only merge if EVERY answer in one is close to EVERY answer in the other. (Comparing
  // averages let groups chain: "grapple gun" ~ "gun" ~ "laser gun" all ended up as one answer.)
  const closeness = (a, b) => {
    let worst = 1;
    for (const x of a.vecs) for (const y of b.vecs) worst = Math.min(worst, cosine(x, y));
    return worst;
  };
  for (;;) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = closeness(clusters[i], clusters[j]);
        if (s >= SAME_MEANING && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    const a = clusters[best.i];
    const b = clusters[best.j];
    clusters = clusters.filter((_, k) => k !== best.i && k !== best.j);
    clusters.push({ ids: [...a.ids, ...b.ids], vecs: [...a.vecs, ...b.vecs] });
  }
  return clusters.map((c) => c.ids);
}

module.exports = { group, keyOf, loadModel, MODEL };
