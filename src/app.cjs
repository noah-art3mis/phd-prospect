// Assembly. Everything above this file is a module that takes what it needs as arguments;
// this is where the arguments come from.
//
// One long-running process owns the Telegram bot, the ingest pipeline and the scheduled
// jobs. The tracer bullet it completes: a link arrives, the bot acks and returns, the ingest
// call runs unawaited, the validated candidate is presented with buttons, and approving it
// writes a confirmed row.

const path = require('node:path');
const { createAnthropicClient } = require('./anthropic.cjs');

const { createTelegram, pollUpdates } = require('./telegram.cjs');
const { createBot } = require('./bot.cjs');
const { createIngest } = require('./ingest.cjs');
const { createApproval } = require('./approval.cjs');
const { loadPrompt } = require('./core/prompt.cjs');
const { scheduleJob } = require('./scheduler.cjs');
const { runReminderSweep } = require('./jobs/reminders.cjs');
const { createAlerter, installTopLevelHandlers } = require('./alerts.cjs');
const { runBackup } = require('./jobs/backup.cjs');
const { runWeeklyDigest } = require('./jobs/digest.cjs');

const INGEST_PROMPT = path.join(__dirname, '..', 'prompts', 'ingest.prompt');

// Not configuration: nobody needs to tune when a backup runs or which day the digest
// arrives, and one more required key is one more way for the app to refuse to start.
const BACKUP_HOUR = 4;
const DIGEST_WEEKDAY = 0; // Sunday

// Anthropic accepts requests up to 32 MB, and base64 inflates bytes by about a third.
// Telegram's own bot API caps downloads at 20 MB, so this is the binding limit either way –
// stated here so the failure names a number rather than surfacing as a request error.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

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

    if (submission.kind === 'document') {
      submission = { ...submission, pdfBase64: await fetchPdf(telegram, submission) };
    }

    const result = await ingest(submission);
    if (!result.ok) {
      // Thrown so the alert path reports it – a failed ingest must never be silent, because
      // silence is the only other thing the user could be seeing.
      throw new Error(result.reason);
    }
    await approval.present(result.candidate);
  };
}

// The PDF is downloaded from Telegram's own API and handed to the model as base64 – nothing
// parses it locally. The Telegram file URL is never given to web_fetch: the bot token is
// embedded in its path, so passing it to an external service would disclose the token.
async function fetchPdf(telegram, submission) {
  if (submission.fileSize && submission.fileSize > MAX_PDF_BYTES) {
    throw new Error(
      `${submission.fileName} is too large to send to the model (${Math.round(submission.fileSize / 1048576)} MB; the limit is 20 MB).`
    );
  }

  const bytes = await telegram.downloadFile(submission.fileId);
  if (bytes.length > MAX_PDF_BYTES) {
    // Telegram does not always report file_size, so the real length is checked too – better
    // a named failure than a truncated record.
    throw new Error(
      `${submission.fileName} is too large to send to the model (${Math.round(bytes.length / 1048576)} MB; the limit is 20 MB).`
    );
  }
  return bytes.toString('base64');
}

function alreadyTracked(opportunity) {
  const deadline = opportunity.deadline_at
    ? `Deadline on file: ${opportunity.deadline_at.slice(0, 10)}.`
    : 'No deadline on file – rolling admission.';
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
  const anthropic = createAnthropicClient({ apiKey: config.anthropicApiKey });
  const prompt = loadPrompt(INGEST_PROMPT);

  // One alert channel, wired into every failure path: the bot's detached work, the polling
  // loop, the scheduled jobs, and anything unhandled at top level.
  const alerter = createAlerter({ telegram, chatId: config.telegramAllowedUserId });
  installTopLevelHandlers({ alerter });

  const app = createApp({ config, store, anthropic, telegram, prompt, onError: alerter.report() });

  const jobs = scheduleJobs({ config, store, telegram, onError: alerter.report(), signal: undefined });

  return Promise.all([
    pollUpdates(telegram, {
      onUpdate: (u) => app.bot.handleUpdate(u),
      // A poll failure is the network being down, which recovers on its own – alerting on
      // every retry would turn one outage into a stream of messages.
      onPollError: (error) => console.error(`poll failed, retrying: ${error.message}`),
      // A handler failure is not that. It is a bug, a rejected send, or a malformed update,
      // and it has to speak: the alternative is the silence that otherwise means "working".
      onUpdateError: alerter.report('handling an update'),
    }),
    ...jobs,
  ]);
}

// The scheduled half of the process. Both jobs are pinned to the configured zone, so
// relocating moves when they arrive rather than shifting them by the new UTC offset.
function scheduleJobs({ config, store, telegram, onError, signal }) {
  const chatId = config.telegramAllowedUserId;
  const common = { zone: config.timezone, onError, signal };
  const backupDirectory = path.join(path.dirname(path.resolve(config.dbPath)), 'backups');

  return [
    scheduleJob({
      ...common,
      name: 'reminders',
      hour: config.reminderSendHour,
      run: () =>
        runReminderSweep({
          store,
          telegram,
          chatId,
          zone: config.timezone,
          leadTimes: config.reminderLeadTimes,
          onError,
        }),
    }),

    // Early morning, before the reminder sweep, so a day's approvals are already on the
    // copy that leaves the box.
    scheduleJob({
      ...common,
      name: 'backup',
      hour: BACKUP_HOUR,
      run: () => runBackup({ store, directory: backupDirectory, bucket: config.gcsBackupBucket }),
    }),

    // Sunday morning. Its absence is the alarm, so it goes out at the same hour reminders
    // do – a time the user already associates with hearing from the bot.
    scheduleJob({
      ...common,
      name: 'digest',
      hour: config.reminderSendHour,
      weekday: DIGEST_WEEKDAY,
      run: () => runWeeklyDigest({ store, telegram, chatId, zone: config.timezone }),
    }),
  ];
}

module.exports = {
  createApp,
  createSubmissionHandler,
  scheduleJobs,
  run,
  alreadyTracked,
  MAX_PDF_BYTES,
};
