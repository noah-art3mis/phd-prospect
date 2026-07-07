// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Authorize and normalize request" — runOnceForAllItems
// Gates to the allowed user, extracts every http(s) URL, SSRF-checks each against the SAME
// non-global ranges the offline validator uses (plus obfuscated-IP and IPv6 rejection), dedupes,
// and fans out one pending item per unique URL. No WHATWG URL, no require.
const allowedUserId = 'REPLACE_WITH_TELEGRAM_USER_ID';
const message = $json.message;
if (!message || String(message.from && message.from.id) !== allowedUserId) {
  throw new Error('Unauthorized Telegram sender');
}
const text = [message.text, message.caption].filter(Boolean).join(' ');
const rawUrls = text.match(/https?:\/\/[^\s<>()]+/g) || [];
if (rawUrls.length === 0) {
  throw new Error('Send at least one http or https opportunity URL');
}

// Mirror of validate_opportunity.js isNonGlobalIpv4: null = not an IPv4 literal, true = non-global, false = global.
function isNonGlobalIpv4(host) {
  var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  var octets = [+m[1], +m[2], +m[3], +m[4]];
  for (var i = 0; i < 4; i++) { if (octets[i] > 255) return null; }
  var n = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  function inRange(cidr, bits) { return (n >>> (32 - bits)) === (cidr >>> (32 - bits)); }
  var ranges = [[0x00000000, 8], [0x0A000000, 8], [0x64400000, 10], [0x7F000000, 8], [0xA9FE0000, 16], [0xAC100000, 12], [0xC0000000, 24], [0xC0000200, 24], [0xC0A80000, 16], [0xC6120000, 15], [0xC6336400, 24], [0xCB007100, 24], [0xE0000000, 4], [0xF0000000, 4]];
  for (var r = 0; r < ranges.length; r++) { if (inRange(ranges[r][0], ranges[r][1])) return true; }
  return false;
}
// Reject anything a WHATWG URL parser (what the fetch client uses) could resolve to a
// non-global address. The gate's regex host and the client's parsed host must not diverge:
// - strict ASCII letter/digit/hyphen/dot only -> kills backslash parser-confusion
//   (http://169.254.169.254\.evil.com), '@'/IPv6, and fullwidth/IDNA hosts that fold to
//   loopback/metadata;
// - no leading/trailing dot or empty label;
// - any host whose last label is numeric or hex is an IP literal in SOME notation
//   (dotted-quad, 1-3 part shorthand like 127.1 / 169.254.43518, bare-decimal, hex/octal) ->
//   allow ONLY a canonical global dotted quad, reject every other numeric form.
function isSafePublicHost(h) {
  if (!h) return false;
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  if (h.charAt(0) === '.' || h.charAt(h.length - 1) === '.' || h.indexOf('..') !== -1) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  var labels = h.split('.');
  var last = labels[labels.length - 1];
  if (/^(0x[0-9a-f]+|\d+)$/i.test(last)) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isNonGlobalIpv4(h) === false;
    return false;
  }
  return true; // a domain name with a non-numeric TLD
}

const seen = new Set();
const items = [];
for (const rawUrl of rawUrls) {
  const cleaned = rawUrl.replace(/[.,;!?]+$/, '');
  const parts = cleaned.match(/^(https?):\/\/(?:([^@/?#]*)@)?([^:/?#]+)(?::(\d+))?([/?#]|$)/i);
  if (!parts) { throw new Error('Could not parse URL: ' + cleaned); }
  const protocol = parts[1].toLowerCase();
  const userinfo = parts[2];
  const hostname = parts[3].toLowerCase().replace(/\.$/, '');
  const port = parts[4] || '';
  if (userinfo || !['http', 'https'].includes(protocol) || !['', '80', '443'].includes(port) || !isSafePublicHost(hostname)) {
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
