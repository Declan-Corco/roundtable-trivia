// Only One: a second opinion from Claude on each round's answers.
//
// The local matcher (matcher.js) groups answers instantly. If the server has an Anthropic API key
// (ANTHROPIC_API_KEY), Claude then checks the round, in one request, while the grading screen is up:
//   - a verdict for EVERY answer: does it fit the category? (with a short reason when it doesn't)
//   - merge: groups that are really the same answer ("Doritos" + "chips")
//   - split: answers that don't mean the same as the rest of their group
// Asking for a verdict on every answer (rather than "list the misfits") makes Claude actually judge
// each one; an empty list was too easy to return. The host can still undo anything.
// Cost: roughly $0.0005-0.001 per round with Claude Haiku 5.5 (see the README). Answers are sent to Anthropic.
const config = require('./config');

const TIMEOUT_MS = 20000;

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
              fits: z.boolean().describe('true if the answer fits the category as worded'),
              why: z.string().describe('empty if it fits; otherwise a few words on why not'),
            })
          )
          .describe('one verdict for every answer id, in the order given'),
        merge: z.array(z.array(z.string())).describe('sets of group ids that are really the same answer'),
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

The answers have already been grouped by a quick automatic matcher. Do three things.

1. verdicts - judge EVERY answer against the category exactly as it is worded. Give one verdict per answer id.
   - Read the whole category. Words like "not", "shouldn't", "never", "without", "worst", "least" or "bad" flip its meaning: for "Things you shouldn't say on a first date", a compliment such as "You look great" does NOT fit, because it is something you should say.
   - Be relaxed about how an answer is written: typos, slang, brand names, a specific example of the category, or a creative stretch that a fair group of friends would accept all fit.
   - An answer does not fit if it means the opposite of the category, has nothing to do with it, is nonsense, or is a joke that ignores the category.
   - For answers that don't fit, give a short reason in "why" (for example "a compliment - fine to say"). Leave "why" empty for answers that fit.
2. merge - groups that are really the same answer written differently: synonyms (couch / sofa), a brand and the thing it is (Keurig / coffee maker), abbreviations (TV / television), spelling or plural differences, or the same remark worded differently.
3. split - answers that do not mean the same thing as the rest of their group. Different kinds of something are different answers (desk lamp / lava lamp, bunk bed / lofted bed, gun / grappling gun).

For merge and split, when unsure, leave the grouping as it is. Use only the ids you are given.`;

/**
 * Asks Claude to check a round.
 * groups: [{ id, entries: [{ id, text }] }] (rejected answers already left out)
 * Returns { misfits: [{ id, why }], merge: [[groupId]], split: [entryId], judged, usage, ms } or throws.
 */
async function check(category, groups) {
  const { Anthropic, client, format } = await getClient();
  const lines = groups.map((g) => `${g.id}: ${g.entries.map((e) => `[${e.id}] ${e.text}`).join(' | ')}`);
  const started = Date.now();
  let response;
  try {
    response = await client.messages.parse({
      model: config.AI_CHECK_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Category: "${category}"\n\nGroups (one per line; answer ids in brackets):\n${lines.join('\n')}` }],
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
  const out = response.parsed_output;
  if (!out) throw new Error("the reply couldn't be read");
  // Keep only ids that were actually in the request.
  const groupIds = new Set(groups.map((g) => g.id));
  const entryIds = new Set(groups.flatMap((g) => g.entries.map((e) => e.id)));
  const verdicts = out.verdicts.filter((v) => entryIds.has(v.id));
  return {
    misfits: verdicts.filter((v) => !v.fits).map((v) => ({ id: v.id, why: String(v.why || '').trim().slice(0, 80) })),
    merge: out.merge.map((set) => set.filter((id) => groupIds.has(id))).filter((set) => set.length > 1),
    split: out.split.filter((id) => entryIds.has(id)),
    judged: new Set(verdicts.map((v) => v.id)).size, // how many answers got a verdict (should be all)
    total: entryIds.size,
    usage: response.usage,
    ms: Date.now() - started,
  };
}

/** Rough cost of one check, for the server log (Claude Haiku 5.5 list prices). */
function costOf(usage) {
  if (!usage) return 0;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return (input * 0.1 + (usage.output_tokens || 0) * 0.5) / 1e6;
}

module.exports = { enabled, check, costOf };
