// What an incoming Telegram update is, decided as a pure function.
//
// The single-user gate lives here, and it is read off the *sender*, never the chat: in a
// group those differ, and the chat id is the weaker of the two. Anything from anyone else
// becomes `ignored`, which carries nothing to act on – no reply, no write.
//
// Everything downstream of this decision is ordinary code that never has to re-check who
// sent something.

// Trailing punctuation is almost always sentence punctuation rather than part of the link;
// a balanced closing bracket is only kept when the URL opened one.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

function trimTrailingPunctuation(url) {
  let trimmed = url.replace(/[.,;:!?]+$/, '');
  while (/[)\]}]$/.test(trimmed)) {
    const closer = trimmed.at(-1);
    const opener = { ')': '(', ']': '[', '}': '{' }[closer];
    const body = trimmed.slice(0, -1);
    if (body.split(opener).length > body.split(closer).length) break;
    trimmed = body;
  }
  return trimmed;
}

function classifyUpdate(update, allowedUserId) {
  const allowed = Number(allowedUserId);
  const ignored = { kind: 'ignored' };

  const callback = update?.callback_query;
  if (callback) {
    if (Number(callback.from?.id) !== allowed) return ignored;
    const [action, rawId] = String(callback.data ?? '').split(':');
    return {
      kind: 'callback',
      action,
      opportunityId: Number(rawId),
      callbackQueryId: callback.id,
      chatId: callback.message?.chat?.id,
      messageId: callback.message?.message_id,
    };
  }

  const message = update?.message;
  if (!message) return ignored;
  if (Number(message.from?.id) !== allowed) return ignored;

  const common = { chatId: message.chat?.id, messageId: message.message_id };

  if (message.document) {
    const { file_id: fileId, file_name: fileName, mime_type: mimeType, file_size: fileSize } = message.document;
    if (mimeType !== 'application/pdf' && !/\.pdf$/i.test(fileName ?? '')) {
      return { ...common, kind: 'unsupported', reason: 'I can only read PDF documents.' };
    }
    return { ...common, kind: 'document', fileId, fileName: fileName ?? 'document.pdf', fileSize };
  }

  const text = message.text ?? message.caption ?? '';
  const match = text.match(URL_PATTERN);
  if (match) return { ...common, kind: 'url', url: trimTrailingPunctuation(match[0]) };

  if (text.trim()) return { ...common, kind: 'text', text: text.trim() };

  return { ...common, kind: 'unsupported', reason: 'Send me a link or a PDF.' };
}

// The immediate reply. It echoes what was received so it is obvious the bot got the right
// thing, and says work is under way so that later silence is a signal rather than ambiguity.
//
// Plain text, like every message this app sends: findings come from pages an attacker
// controls, and with no parse_mode there is nothing to escape.
function acknowledgement(decision) {
  if (decision.kind === 'url') {
    return `Got it – reading ${decision.url}\n\nThis usually takes a minute or two. I'll send the record when it's ready.`;
  }
  if (decision.kind === 'document') {
    return `Got it – reading ${decision.fileName}\n\nThis usually takes a minute or two. I'll send the record when it's ready.`;
  }
  return 'Got it.';
}

module.exports = { classifyUpdate, acknowledgement };
