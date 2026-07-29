// Every failure speaks.
//
// Ingest is fire-and-forget and nothing about an in-flight submission is persisted, so the
// user's only signal is whether a reply arrives. If a failure can be silent then silence
// means both "working" and "died", and there is no way to tell which – that ambiguity is
// what would make the fire-and-forget design unpleasant to live with.
//
// So: one channel, the same chat, a distinct prefix so alerts do not read as ordinary bot
// output. There is no second channel and no external alerting service.

// Chosen to be unmistakable at a glance in a chat that otherwise contains records and
// reminders. Ordinary bot replies never start with this.
const ALERT_PREFIX = '⚠️ PROSPECT ALERT';

function alertText(error, context) {
  const what = context ? `${ALERT_PREFIX} – ${context}` : ALERT_PREFIX;
  const detail = (error?.message ?? String(error)).trim();
  return `${what}\n\n${detail}`;
}

function createAlerter({ telegram, chatId, log = console.error }) {
  // The alert path failing must be logged rather than thrown: an alert about a failed alert
  // would recurse, and taking the process down because Telegram is briefly unreachable
  // would turn a transient outage into the silent death the alerts exist to prevent.
  async function alert(error, context) {
    log(`[alert] ${context ?? ''} ${error?.stack ?? error?.message ?? error}`.trim());
    try {
      await telegram.sendMessage(chatId, alertText(error, context));
    } catch (sendFailure) {
      log(`[alert] could not deliver the alert: ${sendFailure.message}`);
    }
  }

  // The synchronous form the callback-shaped `onError` hooks want. Detached deliberately –
  // callers report and carry on rather than awaiting an alert.
  function report(context) {
    return (error) => {
      void alert(error, context);
    };
  }

  return { alert, report };
}

// An unhandled exception or rejection anywhere at top level produces an alert rather than a
// silent crash. Nothing is rethrown: `unhandledRejection` would otherwise take the process
// down by default on Node 15+, and a bot that dies from one bad update is worse than one
// that reports and keeps polling.
function installTopLevelHandlers({ alerter, process: proc = process }) {
  proc.on('uncaughtException', (error) => {
    void alerter.alert(error, 'unhandled exception');
  });
  proc.on('unhandledRejection', (reason) => {
    void alerter.alert(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled rejection');
  });
}

module.exports = { createAlerter, installTopLevelHandlers, alertText, ALERT_PREFIX };
