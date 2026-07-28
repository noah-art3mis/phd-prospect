// The daily reminder sweep: the shell around the pure core in src/core/reminders.cjs.
//
// The decision – which reminders are due – is a pure function taking `now`, the zone and the
// lead times as arguments. This file is the query, the send, the write-back, and nothing
// else. Keeping them apart is what makes story 26 ("each reminder fires at most once per
// lead time") assertable without waiting a day.
//
// The write-back happens per opportunity, after its sends succeed. A send failure must not
// record the reminder as sent – being nagged twice is a nuisance, being silently skipped for
// a deadline is the outcome this project exists to prevent.

const { dueReminders, recordSent, reminderText } = require('../core/reminders.cjs');

async function runReminderSweep({ store, telegram, chatId, zone, leadTimes, now = new Date(), onError = () => {} }) {
  const opportunities = store.listConfirmed();
  const due = dueReminders({ opportunities, now, zone, leadTimes });

  const byOpportunity = new Map();
  for (const reminder of due) {
    if (!byOpportunity.has(reminder.opportunity_id)) byOpportunity.set(reminder.opportunity_id, []);
    byOpportunity.get(reminder.opportunity_id).push(reminder);
  }

  let sent = 0;
  const failed = [];

  for (const [opportunityId, reminders] of byOpportunity) {
    const delivered = [];
    try {
      for (const reminder of reminders) {
        await telegram.sendMessage(chatId, reminderText(reminder, zone));
        delivered.push(reminder);
        sent += 1;
      }
    } catch (error) {
      failed.push(opportunityId);
      onError(error);
    }

    if (delivered.length > 0) {
      const opportunity = opportunities.find((o) => o.id === opportunityId);
      store.recordRemindersSent(opportunityId, recordSent(opportunity.reminders_sent, delivered));
    }
  }

  return { due: due.length, sent, failed };
}

module.exports = { runReminderSweep };
