// Retrying a call that failed for a reason that might not recur.
//
// The loop is here; the policy stays with the caller. What counts as transient differs
// enough that one shared predicate would have to be wrong for somebody: Telegram must not
// retry "bot was blocked by the user", and an Anthropic call must not retry a timeout,
// because the tokens it generated have already been billed – that is the mistake that turned
// one slow advert into three charges. So `isTransient` is required rather than defaulted:
// there is no sensible default, and a wrong one costs money.
//
// Deliberately not applied to the polling loop in src/telegram.cjs. That one never gives up
// and resets its own backoff on success, which is a different shape from "try this call a
// few times", and squeezing it in here would distort both.

const ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Doubling without a ceiling spends most of a long outage asleep after the service has
// already come back. pollUpdates has capped its own backoff at a minute since the beginning;
// this is the same ceiling, for callers that wait long enough to need one.
const MAX_DELAY_MS = 60_000;

// How long a caller may block, as a number somebody chose. `attempts` cannot express that:
// each attempt also carries its own request timeout, so the wall clock a retrying call
// occupies is the product of two numbers picked in different files, and a comment stating
// that product goes stale the moment either one moves.
async function withRetry(
  operation,
  {
    isTransient,
    attempts = ATTEMPTS,
    baseDelayMs = BASE_DELAY_MS,
    maxDelayMs = MAX_DELAY_MS,
    budgetMs = Infinity,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  const deadline = now() + budgetMs;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // No wait after the final attempt: nobody is going to use the time.
      if (attempt >= attempts || !isTransient(error)) throw error;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      // Nor a wait that outlives the budget: it would end on a call that cannot be made.
      if (now() + delay >= deadline) throw error;
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS };
