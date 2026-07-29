// Resolving a deadline finding to the instant the app stores.
//
// Pure: the zone is an argument, never read from the environment. The spec's rule is that
// resolution happens *at ingest*, with the zone in force then – so changing TZ later moves
// when reminders arrive without reinterpreting a deadline already approved. Keeping this
// function free of ambient state is what makes that property hold.

// The UTC offset a zone was at on a given instant, in minutes. Derived by formatting the
// instant in that zone and reading the wall-clock back, which is what makes daylight saving
// come from the date rather than from today.
function offsetMinutes(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'));
  return (asUtc - instant.getTime()) / 60000;
}

// A wall-clock reading in `zone` as a UTC instant. Two passes: guess the offset at the
// UTC-interpreted instant, correct, then re-check – the second pass fixes readings that sit
// on the far side of a daylight-saving change from the guess.
//
// Spring-forward gaps need the extra step below. On the morning clocks jump 02:00 to 03:00,
// "02:30" is a time that never happened, and the two-pass correction lands on 01:30 – an
// hour *earlier* than asked for. Silently moving a deadline backwards is the worst available
// answer, so a reading inside a gap is moved forward to the first instant that exists, which
// is what every calendar does with the same input.
function fromWallClock({ year, month, day, hour, minute }, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let instant = new Date(naive - offsetMinutes(new Date(naive), zone) * 60000);
  instant = new Date(naive - offsetMinutes(instant, zone) * 60000);

  // If reading the result back in `zone` does not give the wall clock we were asked for, the
  // requested time does not exist. The shortfall is the size of the gap.
  const roundTrip = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes(instant, zone) * 60000;
  if (roundTrip !== instant.getTime()) {
    return new Date(roundTrip);
  }
  return instant;
}

// A deadline value → an ISO instant, or null for rolling admission.
//
// - Already carries an offset (or Z) → that offset wins; the source knows its own timezone.
// - A bare date → the end of that day (23:59) in `zone`, which is what "applications close
//   on the 1st" means to the person reading it.
// - A local date-time with no offset → read in `zone`.
function resolveDeadline(value, zone) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim();

  const withOffset = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (withOffset) {
    const instant = new Date(raw.replace(' ', 'T'));
    if (Number.isNaN(instant.getTime())) throw new Error(`deadline '${raw}' is not a valid instant`);
    return instant.toISOString();
  }

  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    return fromWallClock({ year, month, day, hour: 23, minute: 59 }, zone).toISOString();
  }

  const localDateTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (localDateTime) {
    const [, year, month, day, hour, minute] = localDateTime.map(Number);
    return fromWallClock({ year, month, day, hour, minute }, zone).toISOString();
  }

  // Prose ("sometime in the autumn", "rolling") is not a date. Guessing one here is exactly
  // the invention the evidence rule exists to prevent.
  throw new Error(`deadline '${raw}' is not a date the app can act on`);
}

// A stored instant as the user reads it, in their zone. One formatter rather than one per
// caller, so the approval card, the reminders and the digest cannot drift apart on how a
// date looks.
function formatLocalDate(instant, zone, { month = 'long' } = {}) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month,
    year: month === 'long' ? 'numeric' : undefined,
  }).format(new Date(instant));
}

module.exports = { resolveDeadline, offsetMinutes, formatLocalDate };
