// Where an advert's text is, which is not always where a person found it.
//
// Pure. Given the address the user submitted, this answers with the address to fetch
// instead, or with nothing when the submitted one is already the text.
//
// The shape it exists for: a page that is a program rather than a document. Google Docs
// serves its own interface and draws the document with script; we run no script, so what
// comes back is a menu bar. The document has a second address that is only the content, and
// asking for that one is the whole fix – no credentials, no renderer, no new dependency.
//
// A table rather than a chain of tests along the fetch path. The next application with the
// same shape is a row here; whoever adds it does not have to find every place a decision
// about addresses is currently made, because there is only this one.

const REWRITES = [
  {
    // Not `/d/e/…`: that is Google's published-to-web form, which is server-rendered HTML
    // and already readable. Reading `e` as the document id would build an export address
    // for a document that does not exist.
    // `/u/0/` appears when the reader is signed into more than one account.
    what: 'Google Doc',
    host: 'docs.google.com',
    path: /^\/document\/(?:u\/\d+\/)?d\/(?!e\/)([^/]+)/,
    to: (id) => `https://docs.google.com/document/d/${id}/export?format=txt`,
  },
];

function readableUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    // Not an address. Whatever it is, it is not this function's to reject – the fetcher and
    // the validator both have their own opinion, and this one runs first.
    return null;
  }

  for (const rewrite of REWRITES) {
    if (parsed.hostname !== rewrite.host) continue;
    const match = rewrite.path.exec(parsed.pathname);
    if (!match) continue;
    return { url: rewrite.to(...match.slice(1)), what: rewrite.what };
  }
  return null;
}

// A refusal from an address this module chose, rather than one a person typed, and whether
// it is the end of the road. It usually is: the reason a document is read at a second
// address is that its first one is an interface rather than a document, and web_fetch runs
// no more script than we do. Going on to spend a model call there buys nothing but a slower
// way to be told what the status already said.
//
// The exception is a status that might not last. Google being busy is not the document being
// unreadable, and answering "there is no such document" to a 503 files a permanent verdict
// on a transient fact.
//
// Both statuses below were measured against docs.google.com: an existing document that is
// not shared answers 403 on the export address, and an id that does not exist answers 404.
function notShared(what, status) {
  // Two worlds behind one status – the document is not public, or Google declined to serve
  // this particular client – and nothing here can tell them apart. So it names neither and
  // gives the one action that does: the user opens it and already knows which world it is.
  return (
    `I could not open that ${what} (${status}). Either it is not shared publicly, or Google ` +
    'would not serve it to me. Open it: if it loads, send me the text and I will work from that.'
  );
}

function notThere(what, status) {
  return `There is no ${what} at that address (${status}) – it has been deleted, or the link is wrong.`;
}

const REFUSALS = new Map([
  [401, notShared],
  [403, notShared],
  [404, notThere],
]);

function refusedReason(readable, status) {
  const say = REFUSALS.get(status);
  return say ? say(readable.what, status) : null;
}

module.exports = { readableUrl, refusedReason };
