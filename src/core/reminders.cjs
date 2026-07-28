// The reminder decision, as a pure function.
//
// Everything ambient in the n8n build – the clock, the timezone, the lead times, the
// external "already sent" table – is an argument or a field on the row here. That is what
// makes "each reminder fires at most once per lead time" assertable in-process instead of
// by waiting a day: run it, feed the output back as state, run it again, get nothing.
//
// The job around this (query, send, write-back, schedule) lives in src/jobs/reminders.cjs.

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

// Every reminder due right now: a confirmed opportunity whose deadline is exactly one of
// the lead times away in local calendar days, and whose lead time has not already fired.
// Sorted by deadline, so the message the caller builds reads soonest-first.
function dueReminders({ opportunities, now, zone, leadTimes }) {
  const today = localDayNumber(now, zone);
  const due = [];

  for (const opportunity of opportunities) {
    if (!opportunity.confirmed) continue; // Pending work never behaves like tracked work.
    if (!opportunity.deadline_at) continue; // Rolling admission: nothing to fire on.

    const deadline = new Date(opportunity.deadline_at);
    if (Number.isNaN(deadline.getTime())) continue;

    const daysRemaining = localDayNumber(deadline, zone) - today;
    if (!leadTimes.includes(daysRemaining)) continue;

    const sent = opportunity.reminders_sent || [];
    if (sent.includes(daysRemaining)) continue;

    due.push({
      opportunity_id: opportunity.id,
      title: opportunity.title,
      lead_time: daysRemaining,
      days_remaining: daysRemaining,
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
    if (!updated.includes(reminder.lead_time)) updated.push(reminder.lead_time);
  }
  return updated;
}

// One reminder as the user reads it. Plain text: no parse_mode anywhere in this app, so a
// title lifted from a page an attacker controls has nothing to escape.
function reminderText(reminder, zone) {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(reminder.deadline_at));

  if (reminder.days_remaining === 0) return `Closes today: ${reminder.title} (${when}).`;
  const days = reminder.days_remaining === 1 ? '1 day' : `${reminder.days_remaining} days`;
  return `${days} until ${reminder.title} closes (${when}).`;
}

module.exports = { dueReminders, recordSent, reminderText, localDayNumber };
