#!/usr/bin/env node
// Run the reminder sweep by hand, on the same code path the scheduler uses.
//
//     npm run remind          -- send what is due now
//     npm run remind -- --dry -- list what is due without sending or recording

const { boot } = require('../src/boot.cjs');
const { createTelegram } = require('../src/telegram.cjs');
const { runReminderSweep } = require('../src/jobs/reminders.cjs');
const { dueReminders, reminderText } = require('../src/core/reminders.cjs');

async function main(argv) {
  const { config, store } = boot({ log: () => {} });
  const now = new Date();

  if (argv.includes('--dry')) {
    const due = dueReminders({
      opportunities: store.listConfirmed(),
      now,
      zone: config.timezone,
      leadTimes: config.reminderLeadTimes,
    });
    for (const reminder of due) console.log(reminderText(reminder, config.timezone));
    console.log(`${due.length} due`);
    store.close();
    return;
  }

  const telegram = createTelegram({ token: config.telegramBotToken });
  const result = await runReminderSweep({
    store,
    telegram,
    chatId: config.telegramAllowedUserId,
    zone: config.timezone,
    leadTimes: config.reminderLeadTimes,
    now,
    onError: (e) => console.error(e.message),
  });
  console.log(`${result.due} due, ${result.sent} sent, ${result.failed.length} failed`);
  store.close();
  if (result.failed.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
