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

async function withRetry(
  operation,
  { isTransient, attempts = ATTEMPTS, baseDelayMs = BASE_DELAY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // No wait after the final attempt: nobody is going to use the time.
      if (attempt >= attempts || !isTransient(error)) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

module.exports = { withRetry, ATTEMPTS, BASE_DELAY_MS };
