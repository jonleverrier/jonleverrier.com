/**
 * AN ERROR PAGE SERVED AS A SUCCESS
 *
 *   node --test tools/audit/test/errorpage.test.mjs
 *
 * lloydsbank.com answers 200 with "We are sorry an error has occurred, please try again
 * later." over 65 elements, and it segmented into 12 blocks with area conserved and no
 * notes at all. The status check cannot see it, because the status is fine.
 *
 * Most of this file is about what must NOT be flagged, because that is where the claim
 * is decided: wording alone would flag a site that sells error monitoring, and sparseness
 * alone would flag a homepage that is minimal on purpose — the jonleverrier fixture is
 * one, and it is here as the real page closest to the line.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {errorPageEvidence, errorPageWarning, SPARSE_RECTS, ERROR_PHRASES} from '../lib/errorpage.mjs';
import {runNotes} from '../lib/notes.mjs';
import {loadRects} from '../lib/rects.mjs';

const run = promisify(execFile);

/** `n` ordinary rects, with `heading` as the page's h1 when one is given. */
const page = (n, heading = null) => {
    const rects = [];
    if (heading !== null) {
        rects.push({x: 0, y: 40, w: 800, h: 60, tag: 'h1', boxed: false, text: heading});
    }
    while (rects.length < n) {
        const i = rects.length;
        rects.push({x: 0, y: 100 + i * 20, w: 400, h: 18, tag: 'p', boxed: false, text: `line ${i}`});
    }

    return rects;
};

const LLOYDS = 'We are sorry an error has occurred, please try again later.';

test('the real page: apologetic heading on an all-but-empty page', () => {
    const evidence = errorPageEvidence(page(65, LLOYDS));

    assert.ok(evidence, 'the lloydsbank shape must be flagged');
    assert.equal(evidence.rectCount, 65);
    assert.equal(evidence.heading, LLOYDS, 'facts keep the page text exactly');
});

// The wording half. Same size, an ordinary heading: a small site, not a broken one.
test('a sparse page with an ordinary heading is not an error page', () => {
    assert.equal(errorPageEvidence(page(65, 'Your strategic design partner')), null);
    assert.equal(errorPageEvidence(page(20, 'We build things')), null);
});

// The sparseness half. A page that talks about errors and is full of content is a page
// about errors — an error-monitoring product, a status page, an insurance claim form.
test('a populated page that talks about errors is not an error page', () => {
    const busy = page(SPARSE_RECTS + 1, 'Know when something went wrong, before your users do');

    assert.equal(errorPageEvidence(busy), null);
    assert.ok(busy.length > SPARSE_RECTS, 'this test needs a page above the sparse floor');
});

// The real page closest to the line, from the fixture rather than from a fake: a
// deliberately minimal one-screen homepage, correct as it stands.
test('the sparsest real homepage available is not flagged', () => {
    const {rects} = loadRects('tools/audit/fixtures/jonleverrier.rects.json');

    assert.equal(errorPageEvidence(rects), null);
    assert.ok(rects.length > SPARSE_RECTS, 'the fixture must be above the floor for this to mean anything');
});

test('the retail fixture is not flagged either', () => {
    const {rects} = loadRects('tools/audit/fixtures/retail.rects.json');

    assert.equal(errorPageEvidence(rects), null);
});

// The h1 and nothing else. Stated as a limitation in errorpage.mjs rather than fixed,
// and asserted here so that it is a decision rather than an accident.
test('error wording in the body is not sniffed', () => {
    const rects = page(60, 'Welcome');
    rects.push({x: 0, y: 900, w: 400, h: 20, tag: 'p', boxed: false, text: 'An error has occurred'});

    assert.equal(errorPageEvidence(rects), null);
});

test('with no rects at all nothing is claimed', () => {
    for (const nothing of [null, undefined, []]) {
        assert.equal(errorPageEvidence(nothing), null);
        assert.equal(errorPageWarning(nothing), null);
    }
});

test('every phrase is a sentence about this request failing', () => {
    const headings = [
        'We are sorry an error has occurred, please try again later.',
        'Sorry, something went wrong',
        'Please try again later',
        'This service is temporarily unavailable',
        'Service Unavailable',
        'The page could not be found',
        'Access denied',
        'Your request was blocked',
        'This site is under maintenance',
    ];
    for (const heading of headings) {
        assert.ok(errorPageEvidence(page(40, heading)), `${heading} should be recognised`);
    }
    // And the headings a real homepage writes, which share their words.
    for (const heading of ['Error monitoring for developers', 'Sorry we missed you', 'Page speed, solved']) {
        assert.equal(errorPageEvidence(page(40, heading)), null, `${heading} must not be recognised`);
    }
    assert.ok(ERROR_PHRASES.every((p) => p.flags.includes('i')), 'matching is case-insensitive');
});

// Through the notes, which is what reaches blocks.json and the terminal.
test('the note is attribution, and the message is safe to print', () => {
    const meta = {url: 'https://a.com/', capturedUrl: 'https://a.com/', httpStatus: 200, fullHeight: 1032,
        image: {width: 1440, height: 1032}, consentDismissed: true, scrollCapHit: false};
    const nasty = `${LLOYDS}[2K`;
    const notes = runNotes(meta, 'missing', page(65, nasty));

    assert.ok('errorPageLikely' in notes.conditions);
    assert.equal(notes.conditions.errorPageLikely.effect, 'attribution');
    assert.equal(notes.conditions.errorPageLikely.facts.heading, nasty, 'facts keep the bytes');
    assert.equal(notes.conditions.errorPageLikely.message.includes(''), false, 'the message does not');
});

test('without rects the condition simply does not fire', () => {
    const meta = {url: 'https://a.com/', capturedUrl: 'https://a.com/', httpStatus: 200, fullHeight: 1032,
        image: {width: 1440, height: 1032}, consentDismissed: true, scrollCapHit: false};

    assert.equal('errorPageLikely' in runNotes(meta).conditions, false);
});

// A NOTE, NOT A REFUSAL — the distinction the whole decision rests on. `httpError` makes
// the CLI exit 1 and write nothing; this one must produce a tree, a debug image and a
// blocks.json carrying the warning.
test('the CLI measures the page and says what it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-error-'));
    copyFileSync('tools/audit/fixtures/jonleverrier.png', join(dir, 'fullpage.png'));
    writeFileSync(join(dir, 'rects.json'), JSON.stringify(page(65, LLOYDS)));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        url: 'https://www.lloydsbank.com', capturedUrl: 'https://www.lloydsbank.com/', httpStatus: 200,
        fullHeight: 1296, image: {width: 1440, height: 1296}, consentDismissed: true,
        consentBannerSeen: false, scrollCapHit: false,
    }));

    const {stdout, stderr} = await run('node', ['tools/audit/segment.mjs', dir]);
    const written = JSON.parse(readFileSync(join(dir, 'blocks.json'), 'utf8'));

    assert.ok(existsSync(join(dir, 'debug.png')), 'a noted page is still measured');
    assert.match(stdout, /errorPageLikely/);
    assert.match(stderr, /error page rather than the homepage/);
    assert.equal(written.notes.conditions.errorPageLikely.effect, 'attribution');
    assert.ok(written.tree.w > 0 && written.tree.h > 0);
});
