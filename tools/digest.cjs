#!/usr/bin/env node
// Print the weekly digest without sending it, or send it now.
//
//     npm run digest           -- print what this week's digest would say
//     npm run digest -- --send -- send it to Telegram

const { boot } = require('../src/boot.cjs');
const { createTelegram } = require('../src/telegram.cjs');
const { runWeeklyDigest } = require('../src/jobs/digest.cjs');

async function main(argv) {
  const { config, store } = boot({ log: () => {} });
  const send = argv.includes('--send');

  const telegram = send
    ? createTelegram({ token: config.telegramBotToken })
    : { async sendMessage(_chatId, text) { console.log(text); } };

  try {
    await runWeeklyDigest({ store, telegram, chatId: config.telegramAllowedUserId, zone: config.timezone });
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
