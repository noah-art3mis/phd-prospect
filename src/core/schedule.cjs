// When a scheduled job next runs – pure, so "fires at 9am local, not 9am UTC" is assertable
// without waiting a day.
//
// The schedule is pinned to the configured zone rather than to UTC, so relocating moves
// *when* reminders arrive rather than silently shifting them by the new UTC offset.

const { offsetMinutes } = require('./deadline.cjs');

function localParts(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const at = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(at('year')),
    month: Number(at('month')),
    day: Number(at('day')),
    hour: Number(at('hour')),
    minute: Number(at('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(at('weekday')),
  };
}

function instantFor({ year, month, day, hour }, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  let instant = new Date(naive - offsetMinutes(new Date(naive), zone) * 60000);
  return new Date(naive - offsetMinutes(instant, zone) * 60000);
}

// The next time the local clock reads `hour` – on `weekday` if one is given (0 = Sunday).
// Strictly in the future, so a job that has just run does not immediately run again.
function nextRunAt({ now, zone, hour, weekday = null }) {
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const day = localParts(new Date(now.getTime() + ahead * 86400000), zone);
    if (weekday !== null && day.weekday !== weekday) continue;

    const candidate = instantFor({ ...day, hour }, zone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // Unreachable: eight days always contains the next occurrence of any weekday.
  throw new Error('could not find the next run time');
}

module.exports = { nextRunAt, localParts };
