// The weekly digest job: gather, render, send.
//
// Deliberately unconditional. The whole value is that its absence is the alarm, so there is
// no "nothing to report, skip this week" branch — that branch would make silence ambiguous
// again and undo the point of the job.

const { digestText, upcomingDeadlines } = require('../core/digest.cjs');

async function runWeeklyDigest({ store, telegram, chatId, zone, now = new Date() }) {
  const confirmed = store.listConfirmed();
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

  const text = digestText({
    trackedCount: confirmed.length,
    upcoming: upcomingDeadlines(confirmed, now),
    lastBackup: store.lastSuccessfulBackup(),
    usage: store.usageSince(weekAgo),
    zone,
    now,
  });

  await telegram.sendMessage(chatId, text);
  return { text };
}

module.exports = { runWeeklyDigest };
