// Only One: a second opinion from Claude on each round's answers.
//
// The local matcher (matcher.js) groups answers instantly. If the server has an Anthropic API key
// (ANTHROPIC_API_KEY), Claude then checks the round, in one request, while the grading screen is up:
//   - a verdict for EVERY answer: first a note on what the answer is ("an ice-cream flavor"), then
//     whether it fits the category, and whether it's the same answer as one in another group
//     ("Keurig" -> "coffee maker"). Writing the note first stops neighbouring-category answers
//     ("cookies and cream" for "Chip flavors") slipping through.
//   - split: answers that don't mean the same as the rest of their group
// Asking for a verdict on every answer (rather than "list the misfits" / "list the merges") makes
// Claude actually consider each one; an empty list was too easy to return. The host can undo anything.
// Cost: roughly $0.0005-0.001 per round with Claude Haiku 5.5 (see the README). Answers are sent to Anthropic.
const config = require('./config');
const { keyOf } = require('./matcher');

const TIMEOUT_MS = 20000;
// Big rounds are split into requests of about this many answers that run at the same time, so a
// 45-answer round takes about as long as a 12-answer one (one long reply took over 15 s).
const CHUNK_ANSWERS = 12;

let clientPromise = null;
/** The SDK is loaded on first use, so servers without a key never load it. */
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
      const { z } = await import('zod');
      const Result = z.object({
        verdicts: z
          .array(
            z.object({
              id: z.string().describe('the answer id, e.g. a12'),
              answer: z.string().describe('the answer text, copied exactly as given for that id'),
              note: z.string().describe('a few words on what this answer is, written BEFORE deciding fits'),
              fits: z.boolean().describe('true if players would accept it as one of the things the category asks for'),
              same_as: z.string().describe('the text of an answer in a DIFFERENT group that means the same thing, copied exactly, or empty'),
            })
          )
          .describe('one verdict for every answer id, in the order given'),
        split: z.array(z.string()).describe('ids of answers that do not mean the same thing as the rest of their group'),
      });
      return { Anthropic, client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: TIMEOUT_MS }), format: zodOutputFormat(Result) };
    })();
    clientPromise.catch(() => (clientPromise = null));
  }
  return clientPromise;
}

const enabled = () => !!config.ANTHROPIC_API_KEY;

const SYSTEM = `You referee "Only One", a party game. Each round has a category, like "Things in a dorm room". Teams list as many answers as they can; an answer only scores if no other team wrote the same thing.

The answers have already been grouped by a quick automatic matcher. Do two things.

1. verdicts - judge EVERY answer. Give one verdict per answer id, with "answer", "note", "fits" and "same_as", in that order. "answer" is that id's answer text, copied exactly - it makes sure each verdict lands on the right answer.

   note - first, in at most 6 words, say what the answer actually is ("an ice-cream flavor", "a polite greeting", "a real chip flavor", "a kitchen appliance"). Write it before you decide "fits"; if the answer doesn't fit, this note is the reason shown to the players, so make it clear.

   fits - would most players immediately accept the answer as one of the things the category asks for? Read the category exactly as it is worded.
   - true: a common, recognisable member of the category, in any wording (typos, slang, brand names, a specific example). It doesn't have to be true in every case: "a dog" fits "Things in a house" even though many houses have no dog. If a well-known example of the category fits it (a famous character, a common product, a typical situation), the answer fits.
   - false: it belongs to a different, neighbouring category - an ice-cream flavor given for "Pizza toppings", a dog breed given for "Cat breeds". Don't accept it just because some novelty product or one-off edge case technically exists.
   - false: it means the opposite. Words like "not", "shouldn't", "never", "without", "worst", "least" or "bad" flip the category: for "Things you shouldn't say on a first date", a compliment such as "You look great" does not fit, because it is something you should say.
   - false: it has nothing to do with the category, is nonsense, or is a joke that ignores it.

   same_as - check every answer against the answers in the OTHER groups. If one of them is really the same answer written differently, copy that answer's text here exactly; otherwise leave it empty. The same answer means: synonyms (couch / sofa), a brand and the thing it is (Keurig / coffee maker, Xbox / game console, Doritos / chips), abbreviations (TV / television), spelling or plural differences, or the same remark worded differently ("ur ugly" / "you're ugly"). Different kinds of something are different answers (desk lamp / lava lamp, bunk bed / lofted bed).

2. split - answers that do not mean the same thing as the rest of their own group (for example "grappling hook" grouped with "gun"). When unsure, leave the group as it is.

Use only the ids you are given. If you're asked to judge only some of the groups, give verdicts and splits for those groups only, but compare them against all the answers for same_as.`;

/**
 * Asks Claude to check a round.
 * groups: [{ id, entries: [{ id, text }] }] (rejected answers already left out)
 * Returns { misfits: [{ id, why }], merge: [[groupId]], split: [entryId], judged, total, parts, usage, ms } or throws
 * (only if every part of the check failed).
 */
async function check(category, groups) {
  const { Anthropic, client, format } = await getClient();
  const line = (g) => `${g.id}: ${g.entries.map((e) => `[${e.id}] ${e.text}`).join(' | ')}`;
  const everything = groups.map(line).join('\n');

  // Whole groups, about CHUNK_ANSWERS answers per request.
  const chunks = [];
  let part = [];
  let size = 0;
  for (const g of groups) {
    if (size && size + g.entries.length > CHUNK_ANSWERS) {
      chunks.push(part);
      part = [];
      size = 0;
    }
    part.push(g);
    size += g.entries.length;
  }
  if (part.length) chunks.push(part);

  const ask = async (mine) => {
    const content =
      chunks.length === 1
        ? `Category: "${category}"\n\nGroups (one per line; answer ids in brackets):\n${everything}`
        : `Category: "${category}"\n\nAll the answers this round, for comparing (same_as):\n${everything}\n\n` +
          `Judge ONLY these groups - one verdict for each of their answers, and splits only among these groups:\n${mine.map(line).join('\n')}`;
    let response;
    try {
      response = await client.messages.parse({
        model: config.AI_CHECK_MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('the API key was rejected');
      if (err instanceof Anthropic.RateLimitError) throw new Error('rate limited');
      if (err instanceof Anthropic.APIError) throw new Error(`API error ${err.status ?? ''}`.trim());
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to check this round');
    if (response.stop_reason === 'max_tokens') throw new Error('the reply was cut off');
    if (!response.parsed_output) throw new Error("the reply couldn't be read");
    return response;
  };

  const started = Date.now();
  const settled = await Promise.allSettled(chunks.map(ask));
  const done = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!done.length) throw settled[0].reason; // every part failed
  const out = { verdicts: done.flatMap((r) => r.parsed_output.verdicts), split: done.flatMap((r) => r.parsed_output.split) };
  const usage = {};
  for (const r of done) for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v;
  const failedParts = settled.length - done.length;
  // Each verdict carries the answer's text as well as its id. Claude occasionally writes a verdict
  // against the wrong id (judging "spreadsheet" but labelling it "utility belt"), so the text decides:
  // a mismatched id is relabelled to the answer with that text, or the verdict is dropped if it's unclear.
  const groupOf = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, g.id])));
  const textOf = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, e.text])));
  const idsByKey = new Map();
  for (const [id, text] of textOf) {
    const k = keyOf(text);
    if (!idsByKey.has(k)) idsByKey.set(k, []);
    idsByKey.get(k).push(id);
  }
  let relabelled = 0;
  let dropped = 0;
  const verdicts = [];
  for (const v of out.verdicts) {
    const said = keyOf(v.answer || '');
    if (groupOf.has(v.id) && (!said || keyOf(textOf.get(v.id)) === said)) {
      verdicts.push(v);
      continue;
    }
    const ids = idsByKey.get(said) || [];
    if (ids.length) {
      relabelled++;
      for (const id of ids) verdicts.push({ ...v, id }); // the same text from several tables gets the same verdict
    } else {
      dropped++;
    }
  }
  // "same_as" (by text) -> sets of groups to merge (a + b and b + c become one set a + b + c).
  const parent = new Map();
  const root = (g) => (parent.get(g) && parent.get(g) !== g ? root(parent.get(g)) : g);
  for (const v of verdicts) {
    if (!v.fits || !v.same_as) continue;
    const mine = groupOf.get(v.id);
    const other = (idsByKey.get(keyOf(v.same_as)) || []).map((id) => groupOf.get(id)).find((g) => g !== mine);
    if (!other) continue;
    const a = root(mine);
    const b = root(other);
    if (a !== b) parent.set(b, a);
  }
  const sets = new Map();
  for (const g of new Set(groupOf.values())) {
    const r = root(g);
    if (!sets.has(r)) sets.set(r, []);
    sets.get(r).push(g);
  }
  return {
    misfits: [...new Map(verdicts.filter((v) => !v.fits).map((v) => [v.id, { id: v.id, why: String(v.note || '').trim().slice(0, 80) }])).values()],
    merge: [...sets.values()].filter((set) => set.length > 1),
    split: out.split.filter((id) => groupOf.has(id)),
    judged: new Set(verdicts.map((v) => v.id)).size, // how many answers got a verdict (should be all)
    total: groupOf.size,
    relabelled, // verdicts Claude put on the wrong id, moved to the right answer by its text
    dropped, // verdicts that matched no answer at all
    parts: chunks.length, // requests made (big rounds are split)
    failedParts, // requests that failed (their answers just weren't checked)
    usage,
    ms: Date.now() - started,
  };
}

// List prices in $ per million tokens [input, output], for the cost shown in the server log.
const PRICES = { haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20] };

/** Rough cost of one check, at the list price of the model in use. */
function costOf(usage) {
  if (!usage) return 0;
  const family = Object.keys(PRICES).find((f) => config.AI_CHECK_MODEL.includes(f)) || 'haiku';
  const [inPrice, outPrice] = PRICES[family];
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return (input * inPrice + (usage.output_tokens || 0) * outPrice) / 1e6;
}

module.exports = { enabled, check, costOf };
