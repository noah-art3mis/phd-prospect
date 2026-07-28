// The Telegram edge.
//
// Long polling: the app dials out, so there is no domain, no TLS certificate, no reverse
// proxy, no inbound port — and no incoming request to authenticate. Who is allowed is
// decided in src/core/router.cjs, off the sender id.
//
// Messages carry no parse_mode, anywhere, ever. Findings come from pages an attacker
// controls and are interpolated into the approval card; sending plain text means there is
// nothing to escape, which removes the whole class of bug rather than handling it.

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;

function createTelegram({ token, fetch = globalThis.fetch, apiBase = TELEGRAM_API }) {
  async function call(method, body, { timeoutMs = 90000 } = {}) {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description ?? response.status}`);
    }
    return payload.result;
  }

  // Telegram rejects anything over 4096 characters. A findings-heavy approval card can
  // exceed that, and dropping it would mean an ingest that cost a model call produced
  // nothing — so split, and keep the buttons on the final chunk where they belong.
  function chunk(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  return {
    async sendMessage(chatId, text, { replyMarkup } = {}) {
      const chunks = chunk(String(text));
      let last;
      for (const [index, part] of chunks.entries()) {
        const body = { chat_id: chatId, text: part };
        if (replyMarkup && index === chunks.length - 1) body.reply_markup = replyMarkup;
        last = await call('sendMessage', body);
      }
      return last;
    },

    // Remove the buttons from a card that has been acted on, so it cannot be pressed twice.
    async clearButtons(chatId, messageId) {
      return call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    },

    // Stops the spinner on a pressed button. Telegram wants this within seconds, so it is
    // sent before any of the work the press implies.
    async answerCallbackQuery(callbackQueryId, text) {
      return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    },

    async getUpdates({ offset, timeoutSeconds = 50 }) {
      return call(
        'getUpdates',
        { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
        { timeoutMs: (timeoutSeconds + 20) * 1000 }
      );
    },

    // A PDF is downloaded from Telegram's own API and handed to the model as bytes. The file
    // URL is never given to web_fetch: the bot token is embedded in its path, so passing it
    // to an external service would disclose the token.
    async downloadFile(fileId) {
      const file = await call('getFile', { file_id: fileId });
      const response = await fetch(`${apiBase}/file/bot${token}/${file.file_path}`, {
        signal: AbortSignal.timeout(120000),
      });
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

// The polling loop. `rounds` bounds it for tests; in production it runs until the process
// stops. A poll that fails backs off and retries — losing the network and regaining it has
// to resume without anyone intervening, because nobody is watching the box.
async function pollUpdates(
  telegram,
  { onUpdate, onError = () => {}, rounds = Infinity, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBackoffMs = 60000 }
) {
  let offset;
  let backoffMs = 1000;

  for (let round = 0; round < rounds; round += 1) {
    let updates;
    try {
      updates = await telegram.getUpdates({ offset });
    } catch (error) {
      onError(error);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }
    backoffMs = 1000;

    for (const update of updates) {
      // The offset advances whether or not the handler succeeded. A failing update that is
      // retried forever takes the bot offline, which is worse than dropping it — and the
      // failure is reported through the alert path either way.
      offset = update.update_id + 1;
      try {
        await onUpdate(update);
      } catch (error) {
        onError(error);
      }
    }
  }
}

module.exports = { createTelegram, pollUpdates, MAX_MESSAGE_LENGTH };
