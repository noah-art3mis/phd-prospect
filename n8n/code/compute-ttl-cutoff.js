// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Compute TTL cutoff" — runOnceForAllItems
// Pending approvals older than TTL_DAYS expire; the downstream sweep deletes them and
// notifies once per deleted row (zero deleted rows means the notify node never runs).
const TTL_DAYS = 7;
const cutoff = new Date(Date.now() - TTL_DAYS * 86400000).toISOString();
return [{ json: { cutoff: cutoff, ttl_days: TTL_DAYS } }];
