// Assembly. Everything above this file is a module that takes what it needs as arguments;
// this is where the arguments come from.
//
// One long-running process owns the Telegram bot, the ingest pipeline and the scheduled
// jobs. The tracer bullet it completes: a link arrives, the bot acks and returns, the ingest
// call runs unawaited, the validated candidate is presented with buttons, and approving it
// writes a confirmed row.

const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');

const { createTelegram, pollUpdates } = require('./telegram.cjs');
const { createBot } = require('./bot.cjs');
const { createIngest } = require('./ingest.cjs');
const { createApproval } = require('./approval.cjs');
const { loadPrompt } = require('./core/prompt.cjs');

const INGEST_PROMPT = path.join(__dirname, '..', 'prompts', 'ingest.prompt');

function createSubmissionHandler({ store, telegram, ingest, approval, chatId }) {
  return async function handleSubmission(submission) {
    // Before the model call: a link already tracked answers with the deadline on file,
    // costing nothing (#28).
    if (submission.kind === 'url') {
      const existing = store.findConfirmedByUrl(submission.url);
      if (existing) {
        await telegram.sendMessage(chatId, alreadyTracked(existing));
        return;
      }
    }

    const result = await ingest(submission);
    if (!result.ok) {
      // Thrown so the alert path reports it — a failed ingest must never be silent, because
      // silence is the only other thing the user could be seeing.
      throw new Error(result.reason);
    }
    await approval.present(result.candidate);
  };
}

function alreadyTracked(opportunity) {
  const deadline = opportunity.deadline_at
    ? `Deadline on file: ${opportunity.deadline_at.slice(0, 10)}.`
    : 'No deadline on file — rolling admission.';
  return `Already tracking that one.\n\n${opportunity.title}\n${deadline}`;
}

function createApp({ config, store, anthropic, telegram, prompt, onError }) {
  const chatId = config.telegramAllowedUserId;

  const { ingest } = createIngest({
    anthropic,
    prompt,
    zone: config.timezone,
    onUsage: (usage) => store.recordUsage(usage),
  });

  const approval = createApproval({ store, telegram, zone: config.timezone, chatId });

  const bot = createBot({
    telegram,
    allowedUserId: config.telegramAllowedUserId,
    onSubmission: createSubmissionHandler({ store, telegram, ingest, approval, chatId }),
    onCallback: (decision) => approval.handleCallback(decision),
    onText: async (decision) => {
      const handled = await approval.handleText(decision);
      if (!handled) await telegram.sendMessage(chatId, 'Send me a link or a PDF.');
    },
    onError,
  });

  return { bot, approval, ingest };
}

function run({ config, store }) {
  const telegram = createTelegram({ token: config.telegramBotToken });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const prompt = loadPrompt(INGEST_PROMPT);

  const onError = (error) => console.error(error.stack ?? error.message);
  const app = createApp({ config, store, anthropic, telegram, prompt, onError });

  return pollUpdates(telegram, { onUpdate: (u) => app.bot.handleUpdate(u), onError });
}

module.exports = { createApp, createSubmissionHandler, run, alreadyTracked };
