// Where an advert's text is, as opposed to where it was found.
//
// Live, 27 Aug: the DSSG call – record #10, one day from closing – was stored with no
// deadline. Its address returns 169 characters, every one of them Google's own interface:
//
//   Call para novo Projeto DSSG - Google Docs | Tab | Compartilhar | Fazer login | Arquivo…
//
// The document is drawn by script we do not run. Asked for as plain text, the same id
// returns 5,204 characters including the line the record was missing – "O período de
// candidaturas vai estar aberto até 28 de Agosto." Both figures were measured against the
// live document with the app's own fetchPage.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readableUrl, refusedReason } = require('../src/core/readable-url.cjs');

test('a Google Doc is asked for as text, not as the page that would draw it', () => {
  const read = readableUrl('https://docs.google.com/document/d/1Pt3UEeXt3gVmZ5-IElB0mL1EnjE2ZiiMbIKS87EqMww/edit');

  assert.equal(
    read.url,
    'https://docs.google.com/document/d/1Pt3UEeXt3gVmZ5-IElB0mL1EnjE2ZiiMbIKS87EqMww/export?format=txt'
  );
  // Named, because a failure to read one has to be able to say what it failed to read.
  assert.equal(read.what, 'Google Doc');
});

test('the forms a share link actually arrives in all reach the same document', () => {
  // What a person pastes is whatever Google put in the address bar, which depends on how
  // they opened it and how many accounts they are signed into.
  const id = '1Pt3UEeXt3gVmZ5-IElB0mL1EnjE2ZiiMbIKS87EqMww';
  const expected = `https://docs.google.com/document/d/${id}/export?format=txt`;

  for (const address of [
    `https://docs.google.com/document/d/${id}/edit?usp=sharing`,
    `https://docs.google.com/document/d/${id}/edit#heading=h.abc`,
    `https://docs.google.com/document/d/${id}/view`,
    `https://docs.google.com/document/d/${id}`,
    `https://docs.google.com/document/u/0/d/${id}/edit`,
    `https://docs.google.com/document/d/${id}/mobilebasic`,
  ]) {
    assert.equal(readableUrl(address)?.url, expected, address);
  }
});

test('a document published to the web is left alone, because that page is the document', () => {
  // `/d/e/<id>/pub` is Google's server-rendered form – there is nothing to rewrite, and
  // reading `e` as the document id would build an export address for a document that does
  // not exist.
  assert.equal(readableUrl('https://docs.google.com/document/d/e/2PACX-1vABC123/pub'), null);
});

test('a Google Form is left alone', () => {
  // Forms render their questions into the HTML, and one is already tracked correctly from
  // its own address. A table that rewrote every docs.google.com address would break it.
  assert.equal(
    readableUrl('https://docs.google.com/forms/d/e/1FAIpQLSfSdqjJa64Sa6YSlBvRE6HReSt0lsPuVDHP3lBjSYDgC5YMOg/viewform'),
    null
  );
});

test('an ordinary advert address is not rewritten', () => {
  assert.equal(readableUrl('https://www.vacancies.aau.dk/phd-positions/show-vacancy/vacancyId/955874'), null);
  assert.equal(readableUrl('https://docs.google.example/document/d/abc/edit'), null, 'matched on the path alone');
});

test('something that is not an address is not an error', () => {
  // This runs on whatever the user typed, behind an acknowledgement nobody is awaiting.
  assert.equal(readableUrl('not a url'), null);
  assert.equal(readableUrl(undefined), null);
  assert.equal(readableUrl(''), null);
});

// --- when the address we chose refuses -----------------------------------------------------

test('a refusal from an address we chose is final, and says which document it was', () => {
  // Verified live: an existing document that is not shared answers 403 on the export
  // address, and a document id that does not exist answers 404. Neither is HTML we could
  // mistake for an advert, and neither is worth a model call – the document's own page is
  // the interface, and web_fetch runs no more script than we do.
  const doc = { what: 'Google Doc', url: 'https://docs.google.com/document/d/abc/export?format=txt' };

  assert.match(refusedReason(doc, 403), /Google Doc/);
  assert.match(refusedReason(doc, 403), /403/);
  // Two worlds behind one status – not shared, or Google declining to serve us – and this
  // cannot tell them apart, so it names neither and gives the action that does.
  assert.match(refusedReason(doc, 403), /send me the text/i);

  assert.match(refusedReason(doc, 404), /404/);
  assert.match(refusedReason(doc, 404), /deleted|wrong/i);
});

test('a refusal that might not last is not final', () => {
  // Google being busy or briefly broken is not the document being unreadable. Answering
  // "there is no such document" to a 500 would file a permanent verdict on a transient fact.
  const doc = { what: 'Google Doc', url: 'https://docs.google.com/document/d/abc/export?format=txt' };

  assert.equal(refusedReason(doc, 500), null);
  assert.equal(refusedReason(doc, 429), null);
  // No status at all: a timeout, a DNS failure, a body too large.
  assert.equal(refusedReason(doc, undefined), null);
});
