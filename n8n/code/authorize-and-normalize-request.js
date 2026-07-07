// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
const allowedUserId = 'REPLACE_WITH_TELEGRAM_USER_ID';
const message = $json.message;
if (!message || String(message.from?.id) !== allowedUserId) {
  throw new Error('Unauthorized Telegram sender');
}
const text = [message.text, message.caption].filter(Boolean).join(' ');
const rawUrls = text.match(/https?:\/\/[^\s<>()]+/g) ?? [];
if (rawUrls.length === 0) {
  throw new Error('Send at least one http or https opportunity URL');
}
const privateIpv4 = /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
const seen = new Set();
const items = [];
for (const rawUrl of rawUrls) {
  const cleaned = rawUrl.replace(/[.,;!?]+$/, '');
  const parts = cleaned.match(/^(https?):\/\/(?:([^@/?#]*)@)?([^:/?#]+)(?::(\d+))?([/?#]|$)/i);
  if (!parts) {
    throw new Error('Could not parse URL: ' + cleaned);
  }
  const protocol = parts[1].toLowerCase();
  const userinfo = parts[2];
  const hostname = parts[3].toLowerCase().replace(/\.$/, '');
  const port = parts[4] || '';
  if (userinfo || !['http', 'https'].includes(protocol) || !['', '80', '443'].includes(port) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || privateIpv4.test(hostname)) {
    throw new Error('Source URL is not a safe public web target: ' + cleaned);
  }
  if (seen.has(cleaned)) continue;
  seen.add(cleaned);
  items.push({ json: {
    chat_id: message.chat.id,
    telegram_user_id: message.from.id,
    telegram_update_id: $json.update_id,
    source_url: cleaned,
    received_at: new Date().toISOString(),
    status: 'pending'
  } });
}
items.forEach((it, i) => { it.json.batch_index = i; it.json.batch_size = items.length; });
return items;
