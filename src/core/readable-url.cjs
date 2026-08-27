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

// Two worlds behind one status – the document is not shared, or Google declined to serve
// this particular client – and nothing here can tell them apart. So it names neither and
// gives the one action that does: the user opens it and already knows which world it is.
const docWillNotOpen = (status) =>
  `I could not open that Google Doc (${status}). Either it is not shared publicly, or Google ` +
  'would not serve it to me. Open it: if it loads, send me the text and I will work from that.';

const docIsNotThere = (status) =>
  `There is no Google Doc at that address (${status}) – it has been deleted, or the link is wrong.`;

const REWRITES = [
  {
    host: 'docs.google.com',
    // Not `/d/e/…`: that is Google's published-to-web form, which is server-rendered HTML
    // and already readable. Reading `e` as the document id would build an export address for
    // a document that does not exist. `/u/0/` appears when the reader is signed into more
    // than one account.
    path: /^\/document\/(?:u\/\d+\/)?d\/(?!e\/)([^/]+)/,
    to: (id) => `https://docs.google.com/document/d/${id}/export?format=txt`,

    // Whether a refusal at the address we chose is the end of the road is a property of this
    // site, not of the act of rewriting one. Here it is: the document's own page is an
    // interface drawn by script, and web_fetch runs no more of it than we do, so handing the
    // address on would buy a model call to be told what the status already said.
    //
    // Measured against docs.google.com: an existing document that is not shared answers 403
    // on the export address, and a document id that does not exist answers 404.
    refusals: { 401: docWillNotOpen, 403: docWillNotOpen, 404: docIsNotThere },
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
    return { url: rewrite.to(...match.slice(1)), refusals: rewrite.refusals };
  }
  return null;
}

// What a refusal at a rewritten address means, according to the row that chose it.
//
// A row that claims nothing gets nothing. Falling through to web_fetch is the safe answer,
// and a site that answers 403 to anything but a browser is one it may well read – that class
// of site is why the fetcher asks like a browser in the first place.
//
// Nor is a status that might not last a refusal: Google being busy is not the document being
// unreadable, and answering "there is no such document" to a 503 files a permanent verdict on
// a transient fact.
function refusedReason(readable, status) {
  const say = readable.refusals?.[status];
  return say ? say(status) : null;
}

module.exports = { readableUrl, refusedReason };
