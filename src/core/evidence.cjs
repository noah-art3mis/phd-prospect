// When pasted text was read – a fact the app holds and the model cannot.
//
// Evidence carries a retrieval instant, and for a page the model fetched itself that instant
// is its own to report. Pasted text has no fetch behind it: the app either read the page on
// the model's behalf, after web_fetch refused the address, or the user sent the text in.
// Either way the clock belongs to the shell, and asking the model for the number invites it
// to invent one. Live it declined to – it wrote "unknown (pasted text, no fetch)", which is
// the honest answer and which validate rejects, discarding a complete record over the one
// field nobody could have filled.
//
// So the app writes it. Only onto evidence citing the pasted text: anything the model went
// and fetched keeps the instant it read it, because that one is a real retrieval.

const { canonicalizeUrl } = require('./url.cjs');

function stampRetrieval(candidate, { reference, retrievedAt }) {
  // Compared as links rather than as strings: the reference travels through the prompt and
  // comes back in whatever spelling the model chose, and a stamp that missed on a trailing
  // slash would fail exactly the way the missing stamp did.
  const key = canonicalizeUrl(reference);

  const findings = Object.entries(candidate.findings ?? {}).map(([field, finding]) => [
    field,
    {
      ...finding,
      evidence: (finding.evidence ?? []).map((item) =>
        canonicalizeUrl(item.url) === key ? { ...item, retrieved_at: retrievedAt } : item
      ),
    },
  ]);

  return { ...candidate, findings: Object.fromEntries(findings) };
}

module.exports = { stampRetrieval };
