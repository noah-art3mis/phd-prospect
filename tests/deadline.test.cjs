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

test('a time inside a spring-forward gap moves forward, never backward', () => {
  // On 8 March 2026 New York clocks jump 02:00 to 03:00, so 02:30 never happens. Resolving
  // it to 01:30 would move a deadline an hour earlier than the source stated, silently.
  const resolved = resolveDeadline('2026-03-08T02:30', 'America/New_York');
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(resolved));

  assert.equal(local, '03:30', 'a nonexistent time must land on the first instant that exists');
  assert.ok(
    new Date(resolved) > new Date('2026-03-08T06:59:00.000Z'),
    'the resolved instant must not be earlier than the requested wall clock'
  );
});

test('an ambiguous time on a fall-back day resolves deterministically', () => {
  // 01:30 happens twice on 1 November in New York. Either is defensible; drifting between
  // them run to run is not.
  const first = resolveDeadline('2026-11-01T01:30', 'America/New_York');
  assert.equal(resolveDeadline('2026-11-01T01:30', 'America/New_York'), first);
  assert.equal(first, '2026-11-01T05:30:00.000Z');
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
