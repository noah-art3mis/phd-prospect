// Contract for the retry loop.
//
// The loop is shared; the policy is not. What counts as transient differs enough between
// callers that a single shared predicate would have to be wrong for one of them – Telegram
// must not retry "bot was blocked by the user", and an Anthropic call must not retry a
// timeout, because that one has already been billed for the tokens it generated.

const test = require('node:test');
const assert = require('node:assert/strict');

const { withRetry } = require('../src/retry.cjs');

const never = () => {
  throw new Error('sleep should not have been reached');
};
const instantly = async () => {};

test('a call that works is made once and returned', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      return 'ok';
    },
    { isTransient: () => true, sleep: never }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('a transient failure is retried and the later success is returned', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return 'ok';
    },
    { isTransient: () => true, sleep: instantly }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('a failure the caller calls permanent is raised at once, unretried', async () => {
  // The important half. Retrying a rejected send wastes time; retrying a billed model call
  // wastes money, which is how one slow advert became three charges.
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('bot was blocked by the user');
      },
      { isTransient: () => false, sleep: never }
    ),
    /blocked/
  );
  assert.equal(calls, 1);
});

test('the last failure is raised once the attempts run out', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error(`attempt ${calls}`);
      },
      { isTransient: () => true, attempts: 3, sleep: instantly }
    ),
    /attempt 3/
  );
  assert.equal(calls, 3);
});

test('waits get longer, so a service that is struggling is not hammered', async () => {
  const waits = [];
  await assert.rejects(
    withRetry(async () => { throw new Error('overloaded'); }, {
      isTransient: () => true,
      attempts: 4,
      baseDelayMs: 100,
      sleep: async (ms) => waits.push(ms),
    })
  );

  assert.deepEqual(waits, [100, 200, 400]);
  assert.equal(waits.length, 3, 'a wait after the final attempt is time spent for nothing');
});

test('the error is what decides, so a caller can read its status or its message', async () => {
  const seen = [];
  await assert.rejects(
    withRetry(async () => { const e = new Error('overloaded'); e.status = 529; throw e; }, {
      isTransient: (error) => {
        seen.push(error.status);
        return false;
      },
      sleep: never,
    })
  );
  assert.deepEqual(seen, [529]);
});
