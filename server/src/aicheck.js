// Only One: a second opinion from Claude on each round's answers.
//
// The local matcher (matcher.js) groups answers instantly. If the server has an Anthropic API key
// (ANTHROPIC_API_KEY), Claude then checks the round while the grading screen is up. For every
// distinct answer it returns just: the answer, good or not, and (if any) the answer in another group
// that means the same thing ("Keurig" -> "coffee maker"). Plus answers to split out of their group.
//
// - One entry per answer (not "list the bad ones") makes Claude consider every answer; an empty list
//   was too easy to return.
// - Answers are identified by their text, not by ids (Claude sometimes put a verdict on the wrong
//   id), and each distinct wording is sent once, however many tables wrote it.
// - Big rounds are split into parts that run at the same time, so they take about as long as small ones.
// Cost: about $0.00003-0.00006 per answer with Claude Haiku 5.5 (see the README). Answers are sent to Anthropic.
const config = require('./config');
const { keyOf } = require('./matcher');

const TIMEOUT_MS = 20000;
// Big rounds are split into requests of about this many distinct answers that run at the same time.
const CHUNK_ANSWERS = 15;

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
              answer: z.string().describe('the answer, copied exactly'),
              good: z.boolean().describe('true if it fits the category'),
              same_as: z.string().describe('an answer in a DIFFERENT group that means the same thing, copied exactly, or empty'),
            })
          )
          .describe('one entry for every answer you are asked to judge'),
        split: z.array(z.string()).describe('answers (copied exactly) that do not mean the same thing as the rest of their group'),
      });
      return { Anthropic, client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: TIMEOUT_MS }), format: zodOutputFormat(Result) };
    })();
    clientPromise.catch(() => (clientPromise = null));
  }
  return clientPromise;
}

const enabled = () => !!config.ANTHROPIC_API_KEY;

const SYSTEM = `You referee "Only One", a party game. Each round has a category, like "Things in a dorm room". Teams list as many answers as they can; an answer only scores if no other team wrote the same thing.

The answers have already been grouped by a quick automatic matcher (one group per line). For EVERY answer you're asked to judge, return one entry: the answer copied exactly, "good", and "same_as". Then list any splits.

good - would most players immediately accept the answer as one of the things the category asks for? Read the category exactly as it is worded, and think about what the answer actually is.
- true: a common, recognisable member of the category, in any wording (typos, slang, brand names, a specific example). It doesn't have to be true in every case: "a dog" fits "Things in a house" even though many houses have no dog. If a well-known example of the category fits it (a famous character, a common product, a typical situation), it's good.
- false: it belongs to a different, neighbouring category - an ice-cream flavor given for "Pizza toppings", a dog breed given for "Cat breeds". Don't accept it just because some novelty product or one-off edge case technically exists.
- false: it means the opposite. Words like "not", "shouldn't", "never", "without", "worst", "least" or "bad" flip the category: for "Things you shouldn't say on a first date", a compliment such as "You look great" is not good, because it is something you should say.
- false: it has nothing to do with the category, is nonsense, or is a joke that ignores it.

same_as - only when two answers name the SAME thing: ask "would the two players be picturing the same thing?" If an answer in ANOTHER group is the same thing named differently, copy that answer exactly; otherwise leave it empty.
- Same: synonyms (couch / sofa, soda / pop), abbreviations (TV / television), spelling or plural differences, a brand name used for the item itself (Keurig / coffee maker, Coca-Cola / Coke), or the same remark worded differently ("ur ugly" / "you're ugly").
- NOT the same: a broad term and one kind of it. "bird" is not the same as "parrot", "alcohol" is not "beer" or "vodka", "candy" is not "Skittles", "fruit" is not "apple" - the broad answer covers many different things players would list separately, so it must never knock out the specific ones.
- NOT the same: two different kinds of something (beer / vodka, parrot / parakeet, desk lamp / lava lamp, bunk bed / lofted bed).

split - answers that do not mean the same thing as the rest of their own group, copied exactly: a different thing ("grappling hook" grouped with "gun"), or a broad term grouped with a kind of it ("alcohol" grouped with "beer"). When unsure, leave the group as it is.

If you're asked to judge only some of the groups, give entries and splits for those groups only, but compare against all the answers for same_as.`;

/**
 * Asks Claude to check a round.
 * groups: [{ id, entries: [{ id, text }] }] (rejected answers already left out)
 * Returns { misfits: [{ id, why }], merge: [[groupId]], split: [entryId], judged, total, parts, usage, ms } or throws
 * (only if every part of the check failed).
 */
async function check(category, groups) {
  const { Anthropic, client, format } = await getClient();

  // Answers by their text: each distinct wording once, mapped back to every table that wrote it.
  const groupOf = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, g.id])));
  const idsByKey = new Map();
  const shown = groups.map((g) => {
    const texts = [];
    for (const e of g.entries) {
      const k = keyOf(e.text);
      if (!k) continue;
      if (!idsByKey.has(k)) {
        idsByKey.set(k, []);
        texts.push(e.text);
      }
      idsByKey.get(k).push(e.id);
    }
    return { id: g.id, texts };
  });
  const line = (g) => `${g.id}: ${g.texts.join(' | ')}`;
  const everything = shown.filter((g) => g.texts.length).map(line).join('\n');

  // Whole groups, about CHUNK_ANSWERS distinct answers per request.
  const chunks = [];
  let part = [];
  let size = 0;
  for (const g of shown) {
    if (!g.texts.length) continue;
    if (size && size + g.texts.length > CHUNK_ANSWERS) {
      chunks.push(part);
      part = [];
      size = 0;
    }
    part.push(g);
    size += g.texts.length;
  }
  if (part.length) chunks.push(part);

  const ask = async (mine) => {
    const content =
      chunks.length === 1
        ? `Category: "${category}"\n\nGroups (one per line):\n${everything}`
        : `Category: "${category}"\n\nAll the answers this round, for comparing (same_as):\n${everything}\n\n` +
          `Judge ONLY these groups - one entry for each of their answers, and splits only among these groups:\n${mine.map(line).join('\n')}`;
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
    if (response.stop_reason === 'refusal') throw new Error('the review was declined');
    if (response.stop_reason === 'max_tokens') throw new Error('the reply was cut off');
    if (!response.parsed_output) throw new Error("the reply couldn't be read");
    return response;
  };

  const started = Date.now();
  const settled = chunks.length ? await Promise.allSettled(chunks.map(ask)) : [];
  const done = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (settled.length && !done.length) throw settled[0].reason; // every part failed
  const usage = {};
  for (const r of done) for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v;

  // Verdicts by answer text -> every table's copy of that answer.
  const good = new Map(); // key -> true/false
  const sameAs = new Map(); // key -> key of the same answer in another group
  let dropped = 0;
  for (const v of done.flatMap((r) => r.parsed_output.verdicts)) {
    const k = keyOf(v.answer || '');
    if (!idsByKey.has(k)) {
      dropped++; // an answer that isn't in this round
      continue;
    }
    good.set(k, !!v.good);
    const other = keyOf(v.same_as || '');
    if (v.good && other && idsByKey.has(other)) sameAs.set(k, other);
  }
  // same_as -> sets of groups to merge (a + b and b + c become one set a + b + c).
  const parent = new Map();
  const root = (g) => (parent.get(g) && parent.get(g) !== g ? root(parent.get(g)) : g);
  for (const [k, other] of sameAs) {
    const a = root(groupOf.get(idsByKey.get(k)[0]));
    const b = root(groupOf.get(idsByKey.get(other)[0]));
    if (a !== b) parent.set(b, a);
  }
  const sets = new Map();
  for (const g of new Set(groupOf.values())) {
    const r = root(g);
    if (!sets.has(r)) sets.set(r, []);
    sets.get(r).push(g);
  }
  const groupSize = new Map(groups.map((g) => [g.id, g.entries.length]));
  return {
    misfits: [...good].filter(([, ok]) => !ok).flatMap(([k]) => idsByKey.get(k).map((id) => ({ id, why: '' }))),
    merge: [...sets.values()].filter((set) => set.length > 1),
    split: done
      .flatMap((r) => r.parsed_output.split)
      .flatMap((t) => idsByKey.get(keyOf(t)) || [])
      .filter((id) => groupSize.get(groupOf.get(id)) > 1),
    judged: [...good.keys()].reduce((n, k) => n + idsByKey.get(k).length, 0), // answers that got a verdict (should be all)
    total: groupOf.size,
    distinct: idsByKey.size, // different wordings actually sent to Claude
    relabelled: 0,
    dropped, // entries that matched no answer in the round
    parts: chunks.length, // requests made (big rounds are split)
    failedParts: settled.length - done.length, // requests that failed (their answers just weren't checked)
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
