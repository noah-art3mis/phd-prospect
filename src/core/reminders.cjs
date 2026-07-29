// The reminder decision, as a pure function.
//
// Everything that could be ambient – the clock, the timezone, the lead times, the
// external "already sent" table – is an argument or a field on the row here. That is what
// makes "each reminder fires at most once per lead time" assertable in-process instead of
// by waiting a day: run it, feed the output back as state, run it again, get nothing.
//
// The job around this (query, send, write-back, schedule) lives in src/jobs/reminders.cjs.

const { formatLocalDate } = require('./deadline.cjs');

// Calendar day number for an instant *as seen in `zone`*. Counting in UTC would fire a
// reminder a day early for any deadline late in the local evening.
function localDayNumber(instant, zone) {
  // en-CA formats as YYYY-MM-DD, which is what we want to slice into a day count.
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(instant)
    .split('-')
    .map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

// Every reminder due right now: a confirmed opportunity that has reached a lead time it has
// not yet fired. Sorted by deadline, so the message the caller builds reads soonest-first.
//
// Reached, not landed on. Requiring the day to match a lead time exactly meant one missed
// morning lost the reminder for good – a failed send, a Telegram outage, an app that was
// down, a restart spanning the send hour – because the next day's count no longer matched
// anything. The job already declined to record a failed send, which bought nothing, since
// the decision could never offer it again. This is the half that makes that care pay.
//
// One reminder per opportunity per sweep, the most urgent that has come due. Three weeks of
// downtime should produce one message, not a backlog of three, so the lead times it overtook
// are closed out with it: `closes` is what the caller writes back, and firing the one-day
// warning answers the thirty-day one too.
function dueReminders({ opportunities, now, zone, leadTimes }) {
  const today = localDayNumber(now, zone);
  const due = [];

  for (const opportunity of opportunities) {
    if (!opportunity.confirmed) continue; // Pending work never behaves like tracked work.
    if (!opportunity.deadline_at) continue; // Rolling admission: nothing to fire on.

    const deadline = new Date(opportunity.deadline_at);
    if (Number.isNaN(deadline.getTime())) continue;

    const daysRemaining = localDayNumber(deadline, zone) - today;
    // Past the deadline there is nothing to warn about, and the row stays for the record.
    if (daysRemaining < 0) continue;

    const sent = opportunity.reminders_sent || [];
    // A lead time is moot once a tighter one has already fired: having been told "7 days
    // left", a later "30 days" message would restate a deadline the user has already heard
    // about, in wording that no longer matches how long is actually left.
    const tightestSent = sent.length > 0 ? Math.min(...sent) : Infinity;
    const outstanding = leadTimes.filter(
      (lead) => daysRemaining <= lead && !sent.includes(lead) && lead < tightestSent
    );
    if (outstanding.length === 0) continue;

    due.push({
      opportunity_id: opportunity.id,
      title: opportunity.title,
      // The most urgent one reached: it is the one whose wording matches how little time is
      // actually left, and the others are answered by sending it.
      lead_time: Math.min(...outstanding),
      // What is really left, which after a missed day is not the lead time.
      days_remaining: daysRemaining,
      closes: outstanding,
      deadline_at: opportunity.deadline_at,
    });
  }

  return due.sort((a, b) => (a.deadline_at < b.deadline_at ? -1 : a.deadline_at > b.deadline_at ? 1 : 0));
}

// The state update that makes a run idempotent. Kept next to the decision it closes over
// so the two cannot drift; the job writes the result back to the row.
function recordSent(sent, reminders) {
  const updated = [...(sent || [])];
  for (const reminder of reminders) {
    // Every lead time the send answered, not only the one it was named after: a one-day
    // warning delivered after three weeks of silence has also answered the thirty-day one,
    // and leaving those open would send two more messages about the same deadline.
    for (const lead of reminder.closes ?? [reminder.lead_time]) {
      if (!updated.includes(lead)) updated.push(lead);
    }
  }
  return updated;
}

// One reminder as the user reads it. Plain text: no parse_mode anywhere in this app, so a
// title lifted from a page an attacker controls has nothing to escape.
function reminderText(reminder, zone) {
  const when = formatLocalDate(reminder.deadline_at, zone);

  if (reminder.days_remaining === 0) return `Closes today: ${reminder.title} (${when}).`;
  const days = reminder.days_remaining === 1 ? '1 day' : `${reminder.days_remaining} days`;
  return `${days} until ${reminder.title} closes (${when}).`;
}

module.exports = { dueReminders, recordSent, reminderText, localDayNumber };
