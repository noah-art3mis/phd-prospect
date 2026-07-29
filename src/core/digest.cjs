// The weekly digest, as pure text.
//
// It is a dead-man's switch that carries useful information, so it gets read rather than
// ignored. The daily sweep only speaks when something is due, so its silence is ambiguous –
// no message means either nothing is due or the app is dead. Long polling hides a broken app
// from outside, GCP restarts instances for maintenance, and a post-deploy crash loop is
// silent. That ambiguity would otherwise surface as a missed deadline, the one outcome this
// project exists to prevent.
//
// Which is why it sends even when there is nothing to report. An empty digest is the point.

const { formatLocalDate } = require('./deadline.cjs');

const HORIZON_DAYS = 30;

// Approximate on purpose: summing logged tokens is enough to notice a change in shape, and
// list price is used rather than the introductory rate because an estimate that reads high
// is the safer error.
//
// Four rates, not two. A cache read costs a tenth of fresh input and a cache write a quarter
// above it, so pricing all input alike would make caching – the largest saving available –
// read as no change at all.
const USD_PER_MILLION = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 };

function approximateSpend({
  input_tokens: input = 0,
  cache_read_tokens: cacheRead = 0,
  cache_write_tokens: cacheWrite = 0,
  output_tokens: output = 0,
}) {
  return (
    (input / 1e6) * USD_PER_MILLION.input +
    (cacheRead / 1e6) * USD_PER_MILLION.cacheRead +
    (cacheWrite / 1e6) * USD_PER_MILLION.cacheWrite +
    (output / 1e6) * USD_PER_MILLION.output
  );
}

function describeBackupAge(lastBackup, now) {
  if (!lastBackup) return 'Backup: none on record – check the logs';
  const ageHours = Math.floor((now.getTime() - new Date(lastBackup.occurred_at).getTime()) / 3600000);
  if (ageHours < 36) return `Backup: ${ageHours} hours ago, ok`;
  // A stale backup is visible here, not only in the alert that fired at the time – which is
  // the failure mode a person scrolling past one alert would miss.
  return `Backup: STALE – last successful one was ${Math.floor(ageHours / 24)} days ago`;
}

function digestText({ trackedCount, upcoming, lastBackup, usage, zone, now }) {
  const lines = ['Weekly digest', ''];

  lines.push(`Tracking ${trackedCount} ${trackedCount === 1 ? 'opportunity' : 'opportunities'}.`);
  lines.push('');

  if (upcoming.length === 0) {
    lines.push(`No deadlines in the next ${HORIZON_DAYS} days.`);
  } else {
    lines.push(`Deadlines in the next ${HORIZON_DAYS} days:`);
    for (const opportunity of upcoming) {
      lines.push(`  ${formatLocalDate(opportunity.deadline_at, zone, { month: 'short' })} – ${opportunity.title}`);
    }
  }
  lines.push('');

  lines.push(describeBackupAge(lastBackup, now));

  const spend = approximateSpend(usage);
  lines.push(`Spend this week: about $${spend.toFixed(2)} over ${usage.calls ?? 0} model calls.`);

  return lines.join('\n');
}

// Confirmed opportunities with a deadline inside the horizon, soonest first. Unconfirmed
// rows are already excluded by the caller's query, which is the one predicate every listing
// applies.
function upcomingDeadlines(opportunities, now, horizonDays = HORIZON_DAYS) {
  const until = now.getTime() + horizonDays * 86400000;
  return opportunities
    .filter((o) => o.deadline_at)
    .filter((o) => {
      const at = new Date(o.deadline_at).getTime();
      return at >= now.getTime() && at <= until;
    })
    .sort((a, b) => (a.deadline_at < b.deadline_at ? -1 : 1));
}

module.exports = { digestText, upcomingDeadlines, approximateSpend, HORIZON_DAYS, USD_PER_MILLION };
