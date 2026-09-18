/**
 * CONSENT, IN A BROWSER
 *
 * The other half of consent.test.mjs: not "does this wording mean accept" but "should
 * this control have been touched at all, and what happened when it was".
 *
 *   node --test tools/audit/test/consent-page.test.mjs
 *
 * These drive a real Chromium over local file:// pages. No network — the pages are
 * written to a temp directory here — but a browser is required, which is why they live
 * apart from the pure string tests.
 *
 * THE DEFECT THEY EXIST FOR. On a page with no cookie banner anywhere, an ordinary
 * `<a href="./other.html">OK</a>` was a candidate; clicking it navigated; a navigation
 * detaches every handle; and a handle that can no longer be queried was read as a
 * dismissed banner. The capture then screenshotted the OTHER page, wrote its rects, and
 * printed `consent  dismissed via text "OK"` with exit 0. Every artefact was of a page
 * nobody asked for, and a stranger submitting a URL could choose which one.
 *
 * The context below mirrors lib/capture.mjs's, reducedMotion included, because one of
 * these pages turns on an animation that a real click can never satisfy.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dismissConsent} from '../lib/consent.mjs';
import {VIEWPORT} from '../lib/capture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'audit-consent-'));
const page$ = (name, body) => {
    writeFileSync(join(dir, name), `<!doctype html><html><head><title>${name}</title></head>`
        + `<body style="margin:0">${body}<div style="height:1200px"></div></body></html>`);

    return `file://${join(dir, name)}`;
};

/** Records whether the click arrived as a real pointer press or as el.click(). */
const WATCH = '<script>window.__mousedown = false;'
    + 'addEventListener("mousedown", () => { window.__mousedown = true; }, true);</script>';
const BANNER = (inner, style = '') => '<div id="banner" style="position:fixed;left:0;right:0;bottom:0;'
    + `background:#eee;padding:20px;${style}">`
    + `<p>We use cookies.</p>${inner}</div>`;
const REMOVE = 'document.getElementById(\'banner\').remove()';

/** ESC, then an 8-bit CSI: an ANSI sequence and an ANSI introducer, in a button label. */
const ANSI = `${String.fromCharCode(0x1b)}[2K${String.fromCharCode(0x9b)}31m`;

/**
 * Nothing left that can act on a terminal. Spelled out here rather than imported from
 * lib/printable.mjs on purpose: a test that asks the fix for its own definition of
 * "safe" proves only that the fix agrees with itself.
 */
const inert = (s) => ![...s].some((c) => {
    const n = c.charCodeAt(0);

    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029
        || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
});

const ELSEWHERE = page$('other.html', '<h1>THIS IS NOT THE HOMEPAGE</h1>');
const HOME = '<h1>THIS IS THE HOMEPAGE</h1>';

const URLS = {
    // The reproduction, verbatim: no banner, one ordinary link labelled OK.
    bannerlessLink: page$('bannerless-link.html', `${HOME}<a href="./other.html">OK</a>`),
    // Perfect accept wording, in the ordinary flow of the document. If it is clicked it
    // WILL look like a dismissal — the control hides itself — so only the banner test
    // can refuse it.
    bannerlessButton: page$(
        'bannerless-button.html',
        `${HOME}<button onclick="this.remove()">Accept all cookies</button>`,
    ),
    fixedBanner: page$('fixed-banner.html', HOME + WATCH + BANNER(`<button onclick="${REMOVE}">Accept all cookies</button>`)),
    // A dialog that is not positioned at all: the role is the only evidence it is a banner.
    dialogBanner: page$(
        'dialog-banner.html',
        `${HOME}<div id="banner" role="dialog"><p>We use cookies.</p>`
            + `<button onclick="${REMOVE}">Accept all cookies</button></div>`,
    ),
    // pola.co.jp in miniature: a banner that never stops moving, so Playwright's
    // actionability check never settles and only the DOM-level click can reach it.
    animatedBanner: page$(
        'animated-banner.html',
        HOME + WATCH
            + '<style>@keyframes drift{from{transform:translateY(0)}to{transform:translateY(300px)}}'
            + '#banner{animation:drift .2s linear infinite}</style>'
            + BANNER(`<button onclick="${REMOVE}">Accept all cookies</button>`),
    ),
    // A real banner whose accept control is a link to somewhere else. Consent platforms
    // do this; so does a page built to abuse it.
    navigatingBanner: page$(
        'navigating-banner.html',
        HOME + BANNER('<a role="button" href="./other.html">Accept all cookies</a>'),
    ),
    // A banner whose accept button is labelled with terminal control codes. isAcceptLabel
    // runs regexes only, so this label is accepted, clicked, and then printed — which is
    // the whole of the defect. Built with fromCharCode so the bytes are unambiguous, and
    // deliberately NOT using CR or LF: the HTML parser normalises those away before the
    // label is ever read, and ESC and the 8-bit CSI are what actually survive a page.
    ansiBanner: page$(
        'ansi-banner.html',
        HOME + BANNER(`<button onclick="${REMOVE}">Accept all cookies${ANSI}</button>`),
    ),
};

/**
 * A slow server on the loopback interface. No network beyond this machine.
 *
 * `/` is a banner whose accept control navigates a moment AFTER removing the banner, and
 * `/slow` takes SLOW_MS to answer. That gap is the case a fixed pause cannot cover: the
 * URL only changes when the response commits, so with a slow server the banner is gone,
 * the URL is unchanged, and a dismissal looks confirmed.
 */
const SLOW_MS = 1200;
const serve = (req, res) => {
    if (req.url.startsWith('/slow')) {
        setTimeout(() => {
            res.writeHead(200, {'content-type': 'text/html'});
            res.end('<!doctype html><h1>THIS IS NOT THE HOMEPAGE</h1>');
        }, SLOW_MS);

        return;
    }
    res.writeHead(200, {'content-type': 'text/html'});
    res.end(`<!doctype html><html><head><title>Home</title></head><body style="margin:0">${HOME}`
        + '<div id="banner" style="position:fixed;left:0;right:0;bottom:0;background:#eee;padding:20px">'
        + '<p>We use cookies.</p>'
        + '<div role="button" onclick="document.getElementById(\'banner\').remove();'
        + 'setTimeout(function(){location.href=\'/slow\'},50)">Accept all cookies</div>'
        + '</div><div style="height:1200px"></div></body></html>');
};

let browser;
let context;
let server;
let slowSite;

before(async () => {
    browser = await chromium.launch();
    context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce'});
    server = createServer(serve);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    slowSite = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
    await browser?.close();
    server?.close();
});

/**
 * Load a page, try to dismiss, and report what the page looks like afterwards.
 *
 * The short vendor timeout is not part of what these test: none of these pages carries a
 * CMP selector, so the default 2s per frame is spent waiting for something that is not
 * there. The text pass, which is the subject, keeps its own timings.
 */
const attempt = async (url) => {
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'load'});
    const consent = await dismissConsent(page, 250);
    const state = {
        url: page.url(),
        heading: await page.evaluate(() => document.querySelector('h1').textContent),
        mousedown: await page.evaluate(() => window.__mousedown === true),
        bannerStillThere: await page.evaluate(() => document.getElementById('banner') !== null),
    };
    await page.close();

    return {consent, state};
};

test('an ordinary link labelled OK on a bannerless page is never touched', async () => {
    const {consent, state} = await attempt(URLS.bannerlessLink);
    assert.equal(consent.dismissed, false, 'there was no banner to dismiss');
    assert.equal(consent.via, null);
    assert.equal(consent.navigatedAway, false, 'the link should not have been clicked at all');
    assert.equal(state.url, URLS.bannerlessLink);
    assert.equal(state.heading, 'THIS IS THE HOMEPAGE');
});

test('a perfect accept label outside anything banner-shaped is left alone', async () => {
    const {consent, state} = await attempt(URLS.bannerlessButton);
    assert.equal(consent.dismissed, false, 'a button in the page flow is page furniture, not a banner');
    assert.equal(consent.via, null);
    assert.equal(state.heading, 'THIS IS THE HOMEPAGE');
});

test('a fixed banner is still dismissed', async () => {
    const {consent, state} = await attempt(URLS.fixedBanner);
    assert.equal(consent.dismissed, true);
    assert.match(consent.via, /Accept all cookies/);
    assert.equal(state.bannerStillThere, false);
    assert.equal(state.url, URLS.fixedBanner, 'dismissing must not move the page');
});

// FINDING 11. The label is the page's text and `via` is printed by capture.mjs, so a
// crafted button label used to reach the operator's terminal with its escapes intact.
test('a banner label made of escape characters is dismissed and reported harmlessly', async () => {
    const {consent, state} = await attempt(URLS.ansiBanner);
    assert.equal(consent.dismissed, true, 'the banner is still a banner and still goes');
    assert.equal(state.bannerStillThere, false);
    assert.ok(inert(consent.via), `via must be printable, got ${JSON.stringify(consent.via)}`);
    assert.match(consent.via, /Accept all cookies/, 'and must still say which label worked');
});

test('a dialog role is banner-shaped on its own, without any positioning', async () => {
    const {consent, state} = await attempt(URLS.dialogBanner);
    assert.equal(consent.dismissed, true);
    assert.equal(state.bannerStillThere, false);
});

// The pola.co.jp behaviour, which must survive every narrowing of this module: its banner
// animates continuously, Playwright's click never gets a stable element, and the DOM-level
// fallback is the only thing that reaches it. `mousedown` false is the proof of which path
// fired — el.click() dispatches no pointer events.
test('a banner that never stops moving is dismissed by the DOM-level fallback', async () => {
    const {consent, state} = await attempt(URLS.animatedBanner);
    assert.equal(consent.dismissed, true, 'the fallback must still reach an unclickable banner');
    assert.equal(state.bannerStillThere, false);
    assert.equal(state.mousedown, false, 'a real click should not have been possible here');
});

// THE BLOCKER. A navigation is not a dismissal, whatever it does to the handle.
test('a banner control that navigates is a failure, and the page is put back', async () => {
    const {consent, state} = await attempt(URLS.navigatingBanner);
    assert.equal(consent.dismissed, false, 'navigating away is never a dismissal');
    assert.equal(consent.via, null, 'nothing may be reported as the thing that worked');
    assert.equal(consent.navigatedAway, true);
    assert.equal(consent.restored, true);
    assert.equal(state.url, URLS.navigatingBanner, 'the capture must end on the page it asked for');
    assert.equal(state.heading, 'THIS IS THE HOMEPAGE');
    assert.notEqual(state.url, ELSEWHERE);
});

// …AND A SLOW ONE IS STILL A NAVIGATION. Measured before this test existed: with the
// response held for 1.2s, the banner had removed itself, page.url() was still the old
// URL when the checks ran, and the attempt reported `dismissed: true`. The page then
// arrived on the other document and the whole capture was of it. No pause long enough to
// cover an arbitrary server is one worth paying on every dismissal, so the navigation
// REQUEST is what is watched for.
test('a navigation that commits slowly is caught before it is called a dismissal', async () => {
    const {consent, state} = await attempt(slowSite);
    assert.equal(consent.dismissed, false, 'a slow server must not turn a navigation into a dismissal');
    assert.equal(consent.navigatedAway, true);
    assert.equal(consent.restored, true);
    assert.equal(state.url, slowSite);
    assert.equal(state.heading, 'THIS IS THE HOMEPAGE');
});
