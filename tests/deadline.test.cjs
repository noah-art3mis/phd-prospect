// Contract for resolving a deadline finding to a stored UTC instant.
//
// The rule from the spec: a deadline is resolved to an instant *at ingest*, using the zone
// in force then. Changing TZ later must never reinterpret a deadline already approved – it
// only affects how new ones are read and when reminders arrive.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeadline } = require('../src/core/deadline.cjs');

test('an explicit source offset wins over the configured zone', () => {
  assert.equal(
    resolveDeadline('2026-12-01T23:59:00+01:00', 'America/Mexico_City'),
    '2026-12-01T22:59:00.000Z'
  );
});

test('a bare date is read as end of day in the configured zone', () => {
  // America/Mexico_City is UTC-6, so 23:59 local on 1 September is 05:59Z on the 2nd.
  assert.equal(resolveDeadline('2026-09-01', 'America/Mexico_City'), '2026-09-02T05:59:00.000Z');
});

test('the same bare date in a different zone resolves to a different instant', () => {
  assert.equal(resolveDeadline('2026-09-01', 'Europe/London'), '2026-09-01T22:59:00.000Z');
});

test('a zone with a half-hour offset resolves correctly', () => {
  assert.equal(resolveDeadline('2026-09-01', 'Asia/Kolkata'), '2026-09-01T18:29:00.000Z');
});

test('daylight saving is taken from the date, not from today', () => {
  // London is UTC+1 on 1 July and UTC+0 on 1 January; a fixed offset would get one wrong.
  assert.equal(resolveDeadline('2026-07-01', 'Europe/London'), '2026-07-01T22:59:00.000Z');
  assert.equal(resolveDeadline('2026-01-01', 'Europe/London'), '2026-01-01T23:59:00.000Z');
});

test('a local date-time with no offset is read in the configured zone', () => {
  assert.equal(resolveDeadline('2026-09-01T17:00:00', 'America/Mexico_City'), '2026-09-01T23:00:00.000Z');
});

test('no deadline resolves to null rather than a placeholder date', () => {
  // NULL is how the model represents rolling admission; there is no `rolling` flag.
  assert.equal(resolveDeadline(null, 'America/Mexico_City'), null);
  assert.equal(resolveDeadline('', 'America/Mexico_City'), null);
  assert.equal(resolveDeadline(undefined, 'America/Mexico_City'), null);
});

test('an unparseable value is an error, not a silently wrong instant', () => {
  assert.throws(() => resolveDeadline('sometime in the autumn', 'America/Mexico_City'), /deadline/i);
});

test('resolving is idempotent – a stored instant re-resolves to itself', () => {
  const once = resolveDeadline('2026-09-01', 'America/Mexico_City');
  assert.equal(resolveDeadline(once, 'Europe/London'), once, 'a stored instant must not drift');
});
