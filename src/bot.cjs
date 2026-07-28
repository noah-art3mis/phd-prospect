// The bot loop: gate, acknowledge, dispatch.
//
// Ingest is fire-and-forget. The handler acknowledges and returns; the call runs unawaited
// and delivers the approval message when it finishes. Nothing about an in-flight submission
// is persisted, so a restart mid-ingest drops it — acceptable because the user is present
// and will notice no reply came.
//
// That design only works if failures speak. Every unawaited path reports through onError,
// which the app wires to the Telegram alert channel: silence has to mean "still working"
// and nothing else.

const { classifyUpdate, acknowledgement } = require('./core/router.cjs');

function createBot({
  telegram,
  allowedUserId,
  onSubmission,
  onCallback = async () => {},
  onText = async () => {},
  onError = () => {},
}) {
  // In-flight unawaited work, so tests (and shutdown) can wait for quiet without the
  // production path ever awaiting it.
  const inFlight = new Set();

  function detach(promise) {
    const tracked = Promise.resolve(promise).catch(onError);
    inFlight.add(tracked);
    tracked.finally(() => inFlight.delete(tracked));
  }

  async function handleUpdate(update) {
    const decision = classifyUpdate(update, allowedUserId);

    switch (decision.kind) {
      case 'ignored':
        return;

      case 'url':
      case 'document':
        // Ack first, then detach. The reply must not sit behind a two-minute model call.
        await telegram.sendMessage(decision.chatId, acknowledgement(decision));
        detach(onSubmission(decision));
        return;

      case 'callback':
        // Telegram wants the spinner stopped within seconds, so this happens before the
        // work the press implies.
        await telegram.answerCallbackQuery(decision.callbackQueryId);
        detach(onCallback(decision));
        return;

      case 'text':
        detach(onText(decision));
        return;

      case 'unsupported':
        await telegram.sendMessage(decision.chatId, decision.reason);
        return;

      default:
        return;
    }
  }

  return {
    handleUpdate,
    // Waits for detached work to finish. Used by tests and by shutdown, never by the
    // request path — awaiting it there would defeat the point.
    async settle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

module.exports = { createBot };
