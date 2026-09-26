/**
 * SMOOTH SCROLLING
 *
 *   node --test tools/audit/test/smooth-scroll.test.mjs
 *
 * ogier.com sets `scroll-behavior: smooth` on <html>. A plain `window.scrollTo` then
 * ANIMATES — measured on the live page: 0px moved when read straight after the call,
 * 2000px 1.5s later — and the slicer, reading the position after its settle, decided "the
 * page stopped scrolling at y=0 with 900px of 7032px photographed". The report got one
 * screen of a 7032px page: no explainer, no promotion, no footer, and a hero at 75.6% of
 * "the page", all of it printed into a competitor comparison as findings.
 *
 * TESTED ON THE MECHANISM, because a light local page finishes its animation inside the
 * settle and passes either way: with NO_SMOOTH_SCROLL installed, a scroll lands at once.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {NO_SMOOTH_SCROLL} from '../lib/capture.mjs';

const PAGE = '<!doctype html><html style="scroll-behavior:smooth"><head><title>Smooth</title>'
    + '<style>html{scroll-behavior:smooth}</style></head><body style="margin:0">'
    + '<div style="height:8000px;background:linear-gradient(#c33,#33c)"></div></body></html>';

let server;
let base;
let browser;

before(async () => {
    server = createServer((_, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(PAGE));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

const scrolledAtOnce = async (withFix) => {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    if (withFix) await page.addInitScript(NO_SMOOTH_SCROLL);
    await page.goto(base, {waitUntil: 'load'});
    const y = await page.evaluate(() => { window.scrollTo(0, 3000); return window.scrollY; });
    await page.close();

    return y;
};

test('the page animates a plain scroll, which is the fault', async () => {
    assert.ok(await scrolledAtOnce(false) < 3000, 'if this ever lands at once, the browser changed and the test proves nothing');
});

test('with smooth scrolling switched off for the capture, a scroll lands at once', async () => {
    assert.equal(await scrolledAtOnce(true), 3000);
});
