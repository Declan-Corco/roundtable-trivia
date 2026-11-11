// Only One: a second opinion from Claude on each round's answers (optional).
//
// The local matcher (matcher.js) groups answers instantly. If the server has an Anthropic API key
// (ANTHROPIC_API_KEY), Claude then checks the round in the background, in one request:
//   - misfits: answers that clearly don't fit the category ("banana" for "Things a superhero needs")
//   - merge:   groups that are really the same answer ("Doritos" + "chips")
//   - split:   answers that don't mean the same as the rest of their group
// The game applies the result to the review screen; the host can still undo anything.
// Cost: roughly $0.0003 per round with Claude Haiku 5.5 (see the README). Answers are sent to Anthropic.
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
        misfits: z.array(z.string()).describe('ids of answers that clearly do not fit the category'),
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

The answers have already been grouped by a quick automatic matcher. Check its work:

1. misfits: answers that clearly do not fit the category. Be generous - creative, specific, brand-name or slightly stretched answers that could reasonably fit are fine. Flag only answers a fair referee would throw out: nonsense, jokes that don't fit, or things that obviously aren't in the category.
2. merge: groups that are really the same answer written differently - synonyms (couch / sofa), a brand and the thing it is (Keurig / coffee maker), abbreviations (TV / television), spelling or plural differences.
3. split: answers that do not mean the same thing as the rest of their group. Different kinds of something are different answers (desk lamp / lava lamp, bunk bed / lofted bed, gun / grappling gun).

When unsure, leave things as they are. Use only the ids you are given. Return empty lists if nothing needs changing.`;

/**
 * Asks Claude to check a round.
 * groups: [{ id, entries: [{ id, text }] }] (rejected answers already left out)
 * Returns { misfits: [entryId], merge: [[groupId]], split: [entryId], usage, ms } or throws.
 */
async function check(category, groups) {
  const { Anthropic, client, format } = await getClient();
  const lines = groups.map((g) => `${g.id}: ${g.entries.map((e) => `[${e.id}] ${e.text}`).join(' | ')}`);
  const started = Date.now();
  let response;
  try {
    response = await client.messages.parse({
      model: config.AI_CHECK_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Category: "${category}"\n\nGroups (one per line; answer ids in brackets):\n${lines.join('\n')}` }],
      output_config: { effort: 'low', format },
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
  return {
    misfits: out.misfits.filter((id) => entryIds.has(id)),
    merge: out.merge.map((set) => set.filter((id) => groupIds.has(id))).filter((set) => set.length > 1),
    split: out.split.filter((id) => entryIds.has(id)),
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
