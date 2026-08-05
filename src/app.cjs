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
const { submissionIdentity } = require('./core/url.cjs');
const { createApproval } = require('./approval.cjs');
const { loadPrompt } = require('./core/prompt.cjs');
const { scheduleJob } = require('./scheduler.cjs');
const { runReminderSweep } = require('./jobs/reminders.cjs');
const { createAlerter, installTopLevelHandlers } = require('./alerts.cjs');
const { runBackup } = require('./jobs/backup.cjs');
const { runWeeklyDigest } = require('./jobs/digest.cjs');
const { createTraceWriter } = require('./trace.cjs');
const { fetchPage: fetchPageDefault } = require('./fetch-page.cjs');

const INGEST_PROMPT = path.join(__dirname, '..', 'prompts', 'ingest.prompt');

// Not configuration: nobody needs to tune when a backup runs or which day the digest
// arrives, and one more required key is one more way for the app to refuse to start.
const BACKUP_HOUR = 4;
const DIGEST_WEEKDAY = 0; // Sunday

// Anthropic accepts requests up to 32 MB, and base64 inflates bytes by about a third.
// Telegram's own bot API caps downloads at 20 MB, so this is the binding limit either way –
// stated here so the failure names a number rather than surfacing as a request error.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

// Anthropic's web_fetch refuses some pages that are perfectly readable – a LinkedIn post it
// answered `url_not_allowed` for served 174 KB to an ordinary client on the first try. The
// refusal is the tool declining the address, not the site refusing us, so the advert was
// there the whole time. Rather than tell the user to copy it out by hand, fetch it and hand
// the text back through the same path a paste takes.
//
// Only after web_fetch has already refused, and only the address the user typed: fetches the
// *model* chooses still happen on Anthropic's infrastructure, which is where a page saying
// "now fetch the metadata service" would be obeyed. See src/fetch-page.cjs for the guard.
async function retryFromPage({ submission, failure, ingest, fetchPage, now }) {
  const page = await fetchPage(submission.url);
  // The fallback failing is an implementation detail. What the user needs to hear is why
  // their advert could not be read, which is the failure that got us here.
  if (!page.ok) return failure;
  // Read here, so the instant is ours to state. The model quotes the text and cannot know
  // when it was fetched; every excerpt from it is stamped with this.
  return ingest({ kind: 'paste', url: submission.url, text: page.text, retrievedAt: now().toISOString() });
}

function createSubmissionHandler({ store, telegram, ingest, approval, chatId, fetchPage, now }) {
  // Adverts being read right now. The database cannot answer this: a submission produces no
  // row until its call comes back, so two links arriving together both look new and both get
  // paid for. Memory is the right place for it - it is a fact about this process, and a
  // restart that loses it has also lost the ingest it was tracking.
  const inFlight = new Set();

  return async function handleSubmission(submission) {
    // Before the model call: an advert already known costs nothing to answer (#28). Keyed on
    // identity rather than on the kind of submission, so the same advert is recognised
    // whether it arrives as a link or as the text of one - and a link-less paste is
    // recognised by its text.
    const identity = submission.kind === 'document' ? null : submissionIdentity(submission);

    if (identity) {
      if (inFlight.has(identity)) {
        await telegram.sendMessage(chatId, 'Already reading that one – the record is on its way.');
        return;
      }
      const existing = store.findByUrl(identity);
      if (existing) {
        // Pending and tracked are different answers. A candidate nobody has pressed yet is
        // not "already tracked", and reading it again would buy a second copy of a record
        // that is sitting on the screen.
        await telegram.sendMessage(
          chatId,
          existing.confirmed ? alreadyTracked(existing) : stillWaiting(existing)
        );
        return;
      }
      inFlight.add(identity);
    }

    try {
      await readAndPresent();
    } finally {
      // Released whatever happened: a failure that left the advert permanently unsubmittable
      // would be a worse bug than the double billing this prevents.
      if (identity) inFlight.delete(identity);
    }

    async function readAndPresent() {
    if (submission.kind === 'document') {
      submission = { ...submission, pdfBase64: await fetchPdf(telegram, submission) };
    }

    // Text the user pasted was retrieved by them, at an instant nobody recorded; what the app
    // can state is when it arrived, which is what its evidence cites.
    if (submission.kind === 'paste') submission = { ...submission, retrievedAt: now().toISOString() };

    let result = await ingest(submission);

    // A refused fetch is the one failure the app can do something about itself.
    if (!result.ok && result.refusedFetches?.length > 0 && submission.url) {
      result = await retryFromPage({ submission, failure: result, ingest, fetchPage, now });
    }

    if (!result.ok) {
      // Thrown so the alert path reports it – a failed ingest must never be silent, because
      // silence is the only other thing the user could be seeing.
      throw new Error(result.reason);
    }
    await approval.present(result.candidate);
    }
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

function stillWaiting(opportunity) {
  return `I already read that one – it is waiting for you to approve or reject it.\n\n${opportunity.title}`;
}

function alreadyTracked(opportunity) {
  const deadline = opportunity.deadline_at
    ? `Deadline on file: ${opportunity.deadline_at.slice(0, 10)}.`
    : 'No deadline on file – rolling admission.';
  return `Already tracking that one.\n\n${opportunity.title}\n${deadline}`;
}

// The directory the database lives in. Backups and traces are its neighbours, so all three
// share the one mounted volume and a restore brings back everything that was on the box.
function dataDirectory(config) {
  return path.dirname(path.resolve(config.dbPath));
}

function createApp({ config, store, anthropic, telegram, prompt, trace, fetchPage = fetchPageDefault, now = () => new Date(), onError }) {
  const chatId = config.telegramAllowedUserId;

  const { ingest } = createIngest({
    anthropic,
    prompt,
    zone: config.timezone,
    onUsage: (usage) => store.recordUsage(usage),
    onResponse: (response, submission) => trace.record(response, { url: submission.url ?? submission.fileName }),
  });

  const approval = createApproval({ store, telegram, zone: config.timezone, chatId, now });

  const bot = createBot({
    telegram,
    allowedUserId: config.telegramAllowedUserId,
    onSubmission: createSubmissionHandler({ store, telegram, ingest, approval, chatId, fetchPage, now }),
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

  // Beside the database and the backups, on the mounted volume: a trace is only useful if it
  // survives the container it was written in. The backup job copies the database and nothing
  // else, so traces stay on the box rather than inflating what leaves it.
  const trace = createTraceWriter({ directory: path.join(dataDirectory(config), 'traces') });

  // One alert channel, wired into every failure path: the bot's detached work, the polling
  // loop, the scheduled jobs, and anything unhandled at top level.
  const alerter = createAlerter({ telegram, chatId: config.telegramAllowedUserId });
  installTopLevelHandlers({ alerter });

  const app = createApp({ config, store, anthropic, telegram, prompt, trace, onError: alerter.report() });

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
  const backupDirectory = path.join(dataDirectory(config), 'backups');

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
      run: () => runBackup({ store, directory: backupDirectory, destination: config.backupDestination }),
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
