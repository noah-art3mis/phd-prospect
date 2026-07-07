// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Gates the callback to the allowed user and parses the button payload (p:<action>:<token>).
const upd = $json;
const cq = upd.callback_query;
if (!cq) throw new Error('Not a callback query');
const allowed = 'REPLACE_WITH_TELEGRAM_USER_ID';
if (String(cq.from && cq.from.id) !== allowed) throw new Error('Unauthorized Telegram sender');
const data = String(cq.data || '');
const m = data.match(/^p:([a-z_]+):(.+)$/);
if (!m) throw new Error('Unrecognized callback data: ' + data);
return [{ json: { action: m[1], token: m[2], query_id: cq.id, chat_id: cq.message && cq.message.chat && cq.message.chat.id, message_id: cq.message && cq.message.message_id, telegram_user_id: cq.from.id } }];
