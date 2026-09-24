/**
 * CAPTURE
 *
 *   node --test tools/audit/test/capture.test.mjs
 *
 * HOW TALL IS THE PAGE is the question this file exists for, because phase 1 answered it
 * with `document.body.scrollHeight` and that is not the page height. On example.com it
 * said 96 while the screenshot phase 2 divides by was 900 — three numbers for one
 * quantity, none agreeing, and the one that mattered was in no artefact at all. The same
 * wrong number also told the scroll loop it had reached the bottom, so on any page whose
 * height lives on <html> rather than <body> the loop stopped on its first pass and lazy
 * content never loaded. Exit 0, no warning.
 *
 * The local page below is that shape, in miniature and without a network.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {capturePage, plainUserAgent, pngSize, PAGE_HEIGHT, VIEWPORT} from '../lib/capture.mjs';

// Network-gated: this one hits a real site, so it is opt-in and never runs in a
// plain `node --test`. AUDIT_LIVE=1 node --test tools/audit/test/capture.test.mjs
const live = process.env.AUDIT_LIVE === '1';

test('viewport is locked to 1440x900', () => {
    assert.deepEqual(VIEWPORT, {width: 1440, height: 900});
});

test('pngSize reads the dimensions the segmenter will see', () => {
    // Against a committed fixture, so the numbers come from a real PNG rather than from
    // this file's idea of one.
    const {width, height} = pngSize(readFileSync('tools/audit/fixtures/jonleverrier.png'));
    assert.ok(width > 0 && height > 0);
    assert.equal(width, 1440, 'the fixtures are captured at the locked viewport width');
    assert.ok(height > VIEWPORT.height, 'the fixture is a full-page capture');
});

test('pngSize refuses something that is not a PNG', () => {
    assert.throws(() => pngSize(Buffer.from('not a png at all, not even close')), /not a PNG/);
});

test('capturePage writes all four artefacts', {skip: !live}, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const meta = await capturePage('https://example.com', dir);
    for (const f of ['viewport.png', 'fullpage.png', 'meta.json', 'rects.json']) {
        assert.ok(existsSync(join(dir, f)), `${f} missing`);
    }
    assert.ok(meta.fullHeight > 0);
});

/**
 * A page whose height is on <html>, so the two scrollHeights disagree — captured once
 * and shared, because a capture is several seconds and both tests ask about the same run.
 */
const tallHtmlPage = (() => {
    let pending = null;

    return () => (pending ??= (async () => {
        const dir = mkdtempSync(join(tmpdir(), 'audit-height-'));
        const file = join(dir, 'index.html');
        writeFileSync(file, '<!doctype html><html style="height:3000px">'
            + '<head><title>Tall html, short body</title></head>'
            + '<body style="margin:0;height:100px"><h1>Short body, tall document</h1></body></html>');
        const url = `file://${file}`;

        return {dir, url, meta: await capturePage(url, dir)};
    })());
})();

test('the page-height measure agrees with the PNG when the two scrollHeights disagree', async () => {
    const {dir, url, meta} = await tallHtmlPage();

    // THE PREMISE. A test for "these two numbers disagree" is worth nothing against a
    // page where they happen to agree, so prove the shape as well as the measurement.
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({viewport: VIEWPORT});
        await page.goto(url, {waitUntil: 'load'});
        const seen = await page.evaluate(() => ({
            body: document.body.scrollHeight,
            documentElement: document.documentElement.scrollHeight,
        }));
        assert.notEqual(seen.body, seen.documentElement, 'this page no longer has the shape under test');
        assert.equal(await page.evaluate(PAGE_HEIGHT), Math.max(seen.body, seen.documentElement));
        assert.ok(seen.body < VIEWPORT.height, 'body.scrollHeight would have understated the page');
    } finally {
        await browser.close();
    }

    assert.equal(
        meta.fullHeight,
        meta.image.height,
        'the height in meta must be the height of the image phase 2 divides by',
    );
    assert.ok(meta.fullHeight > VIEWPORT.height, 'the page is taller than one viewport and must measure so');
    assert.equal(meta.image.width, VIEWPORT.width);
    assert.equal(pngSize(readFileSync(join(dir, 'fullpage.png'))).height, meta.image.height);

    // …and the region below the content is then measurable as the gap it is, rather than
    // clamping to 0 against a height smaller than the content itself.
    assert.ok(meta.heightGap.gap > 0, 'the blank space below a 100px body is a real gap');
    assert.ok(meta.heightGap.fraction > 0.5, `most of this page is empty: ${meta.heightGap.fraction}`);
});

test('meta records the URL actually captured beside the one requested', async () => {
    const {url, meta} = await tallHtmlPage();
    assert.equal(meta.url, url);
    assert.equal(meta.capturedUrl, url, 'nothing should have moved the page');
    assert.equal(meta.consentNavigatedAway, false);
});

test('the capture announces itself as plain Chrome, never HeadlessChrome', () => {
    const ua = plainUserAgent('151.0.7922.71', 'linux');
    assert.equal(ua, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');
    assert.doesNotMatch(plainUserAgent('151.0.1', 'darwin'), /Headless/);
});
