// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Formats an Error Trigger payload into a short Telegram alert.
const e = $json;
const workflowName = (e.workflow && e.workflow.name) || 'Unknown workflow';
const exec = e.execution || {};
const err = exec.error || (e.trigger && e.trigger.error) || {};
const failedNode = (err.node && err.node.name) || exec.lastNodeExecuted || '(trigger)';
const message = err.message || err.description || 'Unknown error';

// Best effort: surface a source_url if the failed execution data carries one.
let sourceUrl = '';
const match = JSON.stringify(e).match(/"source_url"\s*:\s*"((?:[^"\\]|\\.)+)"/);
if (match) {
  try { sourceUrl = JSON.parse('"' + match[1] + '"'); } catch (parseErr) { sourceUrl = match[1]; }
}

const lines = [
  '🚨 Workflow error: ' + workflowName,
  'Node: ' + failedNode,
  'Error: ' + String(message).slice(0, 500)
];
if (sourceUrl) lines.push('Source: ' + sourceUrl);
if (exec.url) lines.push(exec.url);

return { json: { alert_text: lines.join('\n') } };
