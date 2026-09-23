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
import {dismissConsent, dismissLateConsent} from '../lib/consent.mjs';
import {SHADOW_INIT} from '../lib/shadow.mjs';
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

/** How long after load the late banner appears. Short; the mechanism is the subject, not the wait. */
const LATE_MS = 400;

/** Markup that is not on the page when it loads, and is a moment later. */
const arrivesLate = (html) => `<script>setTimeout(function () {
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
}, ${LATE_MS});</script>`;

/**
 * A web component: `#host` inside `#mount`, with `inner` in an OPEN shadow root on it.
 *
 * `style` goes on the host, in the light DOM, which is where a component's positioning
 * usually lives and which is exactly what an ancestor walk cannot reach from inside.
 */
const component = (style, inner) => `<div id="mount"><div id="host" style="display:block;${style}"></div></div>`
    + `<script>document.getElementById('host').attachShadow({mode: 'open'}).innerHTML = ${JSON.stringify(inner)};</script>`;

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
    // visionarygrid.studio. A Finsweet bar whose wrapper is `position: absolute`, sized to
    // one viewport, with an `<a role="button">` accept — matched CLICKABLE perfectly and was
    // refused by all three banner gates on the position of its container.
    absoluteBanner: page$(
        'absolute-banner.html',
        `${HOME}<div id="banner" style="position:absolute;top:0;left:0;width:100%;height:900px">`
            + '<p>By clicking Accept you agree to the storing of cookies on your device.</p>'
            + `<a href="#" role="button" onclick="${REMOVE};return false">Accept</a></div>`,
    ),
    // www.gov.uk. The GOV.UK Design System banner is IN NORMAL FLOW — `position: static`
    // on the banner and on every one of its ancestors — so it pushes the page down instead
    // of sitting over it. All three gates tested only for positioning, so a 325px banner
    // filling the top of the capture reported `consentBannerSeen: false`.
    inFlowBanner: page$(
        'inflow-banner.html',
        '<div id="banner" style="width:100%;background:#f3f2f1;padding:20px">'
            + '<h2>Cookies on GOV.UK</h2>'
            + '<p>We use some essential cookies to make this website work.</p>'
            + `<button onclick="${REMOVE}">Accept additional cookies</button>`
            + `<button onclick="${REMOVE}">Reject additional cookies</button></div>${HOME}`,
    ),
    // The safety case for the rule above. Same shape exactly — an in-flow band across the
    // top of the document — saying nothing about consent. Its button carries a perfect
    // accept label, so only the wording gate can save it.
    inFlowHeader: page$(
        'inflow-header.html',
        '<div id="banner" style="width:100%;background:#eee;padding:20px">'
            + '<p>Welcome to the shop.</p>'
            + `<button onclick="${REMOVE}">Accept</button></div>${HOME}`,
    ),
    // www.gov.uk, the half that only shows up after the click: accepting replaces the banner
    // with a confirmation band of its own, 160px of it, which is still consent furniture
    // and still counted as the site's surface area.
    confirmingBanner: page$(
        'confirming-banner.html',
        '<div id="banner" style="width:100%;background:#f3f2f1;padding:20px">'
            + '<h2>Cookies on this site</h2><p>We use some essential cookies.</p>'
            + '<button onclick="document.getElementById(\'banner\').outerHTML = '
            + '\'&lt;div id=&quot;after&quot; style=&quot;width:100%;background:#f3f2f1;padding:20px&quot;&gt;'
            + 'You have accepted additional cookies. &lt;button&gt;Hide cookie message&lt;/button&gt;&lt;/div&gt;\'">'
            + 'Accept additional cookies</button></div>' + HOME,
    ),
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
    // boondmanager.com's shape: an ordinary in-flow element with a computed position of
    // `relative`, held in the viewport by script. No reading of the stylesheet can tell it
    // from page furniture; only having WATCHED it hold its place can.
    heldBanner: page$(
        'held-banner.html',
        `${HOME}<div id="banner" style="position:relative;background:#eee;padding:20px">`
            + `<p>We use cookies.</p><button onclick="${REMOVE}">Accept all cookies</button></div>`,
    ),
    // THE LATE BANNER. boondmanager.com's Axeptio card is loaded by a tag manager and opens
    // about eight seconds in, three viewports down the scroll pass — long after the one
    // attempt at consent had run and gone. Nothing here is wrong at load; there is simply
    // nothing there yet.
    lateBanner: page$(
        'late-banner.html',
        HOME + arrivesLate(BANNER(`<button onclick="${REMOVE}">Accept all cookies</button>`)),
    ),
    // …AND WHAT ELSE IS ON THE PAGE BY THEN. The second attempt runs after the scroll pass,
    // where the pinned census has marked hundreds of elements as holding the viewport and
    // `IS_BANNER_SHAPED` would accept any of them. This panel is fixed, says nothing about
    // consent, carries a perfect accept label, and REMOVES ITSELF when clicked — so a
    // looser gate does not merely click it, it reports the click as the dismissal. It comes
    // first in the DOM, which is the order the controls are tried in.
    lateBannerAndFurniture: page$(
        'late-furniture.html',
        HOME + arrivesLate(
            '<div id="furniture" style="position:fixed;top:0;left:0;right:0;background:#ddd;padding:20px">'
            + '<p>Join our newsletter for product news.</p>'
            + '<button onclick="document.getElementById(\'furniture\').remove()">Accept</button></div>'
            + BANNER(`<button onclick="${REMOVE}">Accept all cookies</button>`),
        ),
    ),
    // A banner that is there from the start and cannot be got rid of. The first attempt
    // sees it, clicks it and gets nowhere; the click is COUNTED, so a second attempt on a
    // banner that has already been refused is visible rather than merely wasteful.
    stubbornBanner: page$(
        'stubborn-banner.html',
        HOME + BANNER('<button onclick="window.__clicks = (window.__clicks || 0) + 1">Accept all cookies</button>'),
    ),
    // A BANNER INSIDE A WEB COMPONENT, with the positioning on the HOST — the ordinary
    // `<my-cookie-banner style="position:fixed">` shape. The ancestor walk hits
    // `parentElement === null` at the top of the shadow tree, so before it crossed to the
    // host it concluded that an accept button sitting in a fixed banner was page furniture.
    shadowBanner: page$(
        'shadow-banner.html',
        HOME + component(
            'position:fixed;left:0;right:0;bottom:0;background:#eee;padding:20px',
            '<div id="banner" style="width:400px;height:120px"><p>We use cookies.</p>'
            + '<button onclick="this.getRootNode().host.remove()">Accept all cookies</button></div>',
        ),
    ),
    // A FRAME THAT NEVER ANSWERS. bakerandpartners.com carries one whose URL is the empty
    // string: `frame.evaluate` on it returns never — measured at 60s and given up on rather
    // than waited out — so the search for a banner stopped there and spent the whole
    // three-minute capture budget, and the capture died with no artefacts at all. Its JS
    // thread is blocked here instead, which is the same thing from outside; the spin ends on
    // its own so a machine running this suite never loses a core for longer than that.
    hangingFrame: page$(
        'hanging-frame.html',
        `${HOME}<iframe style="width:200px;height:100px" srcdoc="`
            + '&lt;script&gt;const end = Date.now() + 20000; while (Date.now() &lt; end) {}&lt;/script&gt;'
            + '"></iframe>',
    ),
    // The same component with NO accept control, which is the other half of the answer: a
    // wall we cannot get past still has to be SEEN, or the run reports "no banner found" on
    // a page carrying one. `textContent` on a host returns its light DOM only, so the card
    // is findable only by walking into the shadow root.
    shadowCard: page$(
        'shadow-card.html',
        HOME + component(
            'position:fixed;left:0;right:0;bottom:0;background:#eee;padding:20px',
            '<div id="banner" style="width:400px;height:120px"><p>We use cookies to measure the audience.</p></div>',
        ),
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
/** `#banner`, wherever it is — a page's own document, or a component's shadow root. */
const BANNER_ELEMENT = () => {
    const host = document.getElementById('host');

    return document.getElementById('banner')
        ?? (host && host.shadowRoot ? host.shadowRoot.getElementById('banner') : null);
};

/** What the page looks like once consent has had its go at it. */
const look = async (page) => ({
    url: page.url(),
    heading: await page.evaluate(() => document.querySelector('h1').textContent),
    mousedown: await page.evaluate(() => window.__mousedown === true),
    bannerStillThere: await page.evaluate(BANNER_ELEMENT) !== null,
    furnitureStillThere: await page.evaluate(() => document.getElementById('furniture') !== null),
    clicks: await page.evaluate(() => window.__clicks ?? 0),
    // The band a dismissed banner can leave behind: present in the DOM, and the question
    // is whether it would be DRAWN — which is what the capture measures.
    confirmationVisible: await page.evaluate(() => {
        const el = document.getElementById('after');

        return el !== null && getComputedStyle(el).display !== 'none';
    }),
});

const open = async (url, pinned) => {
    const page = await context.newPage();
    // As lib/capture.mjs installs it, and for the same reason: without it the ancestor walk
    // stops at a shadow boundary and the banner-shape tests answer about the component
    // rather than about the page.
    await page.addInitScript(SHADOW_INIT);
    await page.goto(url, {waitUntil: 'load'});
    // The mark lib/pinned.mjs leaves on an element it MEASURED holding its viewport box.
    // Set by hand here so this file stays a test of the consent rules rather than of the
    // census that feeds them; the census's own half is in test/slices.test.mjs.
    if (pinned) {
        await page.evaluate(() => {
            const el = document.getElementById('banner')
                ?? document.getElementById('host').shadowRoot.getElementById('banner');
            el.__auditPinned = true;
        });
    }

    return page;
};

const attempt = async (url, {pinned = false} = {}) => {
    const page = await open(url, pinned);
    const consent = await dismissConsent(page, 250);
    const state = await look(page);
    await page.close();

    return {consent, state};
};

/**
 * Both attempts on one page, as lib/capture.mjs makes them: the load-time one, then the
 * scroll pass (which is only a wait here — what the banner is waiting for is time, not
 * scrolling), then the second.
 */
const bothAttempts = async (url, {pinned = false, waitMs = LATE_MS + 200} = {}) => {
    const page = await open(url, pinned);
    const first = await dismissConsent(page, 250);
    await page.waitForTimeout(waitMs);
    const consent = await dismissLateConsent(page, first, 250);
    const state = await look(page);
    await page.close();

    return {first, consent, state};
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
/**
 * visionarygrid.studio. Its consent bar is `position: absolute`, and all three banner
 * gates enumerated `fixed` and `sticky` while each describing the principle as "taken out
 * of the flow so it can sit over the page" — which absolute also satisfies. The capture
 * recorded `consentBannerSeen: false` about a banner sitting in its own screenshot.
 */
test('an absolutely positioned banner is seen and dismissed', async () => {
    const {consent, state} = await attempt(URLS.absoluteBanner);
    assert.equal(consent.bannerSeen, true, 'it must at minimum be reported as there');
    assert.equal(consent.dismissed, true);
    assert.equal(state.bannerStillThere, false);
    assert.equal(state.url, URLS.absoluteBanner, 'dismissing must not move the page');
});

/**
 * www.gov.uk. Its banner is `position: static`, like every ancestor above it, because the
 * GOV.UK Design System puts the banner in the document flow and lets it push the page
 * down. Measured on the real capture: `consentBannerSeen: false`, and 325px — 6.6% of a
 * 4,923px page — counted as surface area the site had chosen to spend.
 */
test('an in-flow banner at the top of the page is seen and dismissed', async () => {
    const {consent, state} = await attempt(URLS.inFlowBanner);
    assert.equal(consent.bannerSeen, true, 'it must at minimum be reported as there');
    assert.equal(consent.dismissed, true);
    assert.equal(state.bannerStillThere, false);
    assert.equal(state.url, URLS.inFlowBanner, 'dismissing must not move the page');
});

/**
 * The other half of that rule, and the reason it is safe. In-flow bands across the top of
 * a document are ordinary — every site header is one — so shape cannot decide anything
 * here any more than `fixed` can. This one says nothing about cookies, and its button is
 * labelled as perfectly as a real banner's.
 */
test('an in-flow band at the top that says nothing about consent is left alone', async () => {
    const {consent, state} = await attempt(URLS.inFlowHeader);
    assert.equal(consent.dismissed, false, 'a header is not a banner, whatever its buttons say');
    assert.equal(consent.via, null);
    assert.equal(state.bannerStillThere, true);
});

/**
 * The confirmation band. gov.uk swaps its banner for "You have accepted additional cookies"
 * with a Hide button, and rejecting produces the same band with the other verb, so no
 * choice of click avoids it. It is hidden rather than clicked — see hideConsentRemnant.
 */
test('the band a dismissed banner leaves behind is hidden too', async () => {
    const {consent, state} = await attempt(URLS.confirmingBanner);
    assert.equal(consent.dismissed, true);
    assert.equal(consent.remnants, 1, 'the confirmation band must be found and hidden');
    assert.equal(state.confirmationVisible, false, 'and must not be drawn in the capture');
});

test('a banner label made of escape characters is dismissed and reported harmlessly', async () => {
    const {consent, state} = await attempt(URLS.ansiBanner);
    assert.equal(consent.dismissed, true, 'the banner is still a banner and still goes');
    assert.equal(state.bannerStillThere, false);
    assert.ok(inert(consent.via), `via must be printable, got ${JSON.stringify(consent.via)}`);
    assert.match(consent.via, /Accept all cookies/, 'and must still say which label worked');
});

// THE BOONDMANAGER DEFECT, both directions. A candidate had to sit under a fixed or sticky
// ancestor, so a card held in the viewport by script was never offered — and the run
// reported no banner on a page carrying one.
test('a banner held in the viewport by script is dismissed once it has been measured', async () => {
    const {consent, state} = await attempt(URLS.heldBanner, {pinned: true});
    assert.equal(consent.bannerSeen, true);
    assert.equal(consent.dismissed, true);
    assert.equal(state.bannerStillThere, false);
});

test('…and the same page with nothing measured is left alone, because nothing says it is a banner', async () => {
    // The control. `position: relative` in the document flow is page furniture until
    // something has watched it hold the viewport, and clicking page furniture is the defect
    // this module was narrowed to prevent.
    const {consent, state} = await attempt(URLS.heldBanner);
    assert.equal(consent.dismissed, false);
    assert.equal(state.bannerStillThere, true);
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

/* ------------------------------------------ a banner that was not there when we asked */

// THE DEFECT TASK 18 EXISTS FOR, in miniature. boondmanager.com's consent card opens about
// eight seconds in, three viewports down the scroll pass; the one attempt at consent had
// run and gone by then, so the card was never offered a click, painted twelve times down
// the capture, and `consentBannerSeen` reported false on a page carrying it in plain sight.
test('a banner that arrives after the page has loaded is dismissed by the second attempt', async () => {
    const {first, consent, state} = await bothAttempts(URLS.lateBanner);
    assert.equal(first.dismissed, false, 'the premise: there is nothing there when the first attempt runs');
    assert.equal(first.bannerSeen, false, 'and nothing to see either');
    assert.equal(consent.dismissed, true);
    assert.equal(consent.bannerSeen, true);
    assert.equal(consent.arrivedLate, true, 'and the record says the page was not measured without it');
    assert.match(consent.via, /after the scroll pass/);
    assert.equal(state.bannerStillThere, false);
    assert.equal(state.url, URLS.lateBanner, 'dismissing must not move the page');
});

// WHAT ELSE IS ON THE PAGE BY THEN. The second attempt runs after the scroll pass, where
// the pinned census has marked hundreds of elements as holding the viewport and
// IS_BANNER_SHAPED accepts any of them. This panel is fixed, says nothing about consent,
// carries a perfect accept label and removes itself when clicked — so the loose gate would
// not merely click it, it would report the click as the dismissal and leave the banner up.
test('a fixed panel that says nothing about consent is not clicked by the second attempt', async () => {
    const {consent, state} = await bothAttempts(URLS.lateBannerAndFurniture);
    assert.equal(state.furnitureStillThere, true, 'the newsletter panel is page furniture, not a banner');
    assert.equal(consent.dismissed, true, 'and the real banner is still found');
    assert.match(consent.via, /Accept all cookies/);
    assert.equal(state.bannerStillThere, false);
});

// A BANNER THE FIRST ATTEMPT ALREADY REFUSED IS NOT CLICKED AGAIN. It has had its one
// attempt; a second buys nothing but the time it costs, on a page that has just proved slow.
test('a banner that was already seen and not dismissed is not clicked a second time', async () => {
    const {first, consent, state} = await bothAttempts(URLS.stubbornBanner, {waitMs: 0});
    assert.equal(first.bannerSeen, true, 'the premise: this banner was there from the start');
    assert.equal(first.dismissed, false, 'and clicking it does nothing');
    assert.equal(consent.arrivedLate, false, 'nothing arrived late — this is the same banner');
    assert.equal(consent.bannerSeen, true, 'and it is still counted as surface area');
    assert.equal(state.clicks, 1, 'the accept control was clicked exactly once, by the first attempt');
});

// …AND NEITHER IS A PAGE WITH NOTHING ON IT. The common case, and the one the cost is paid
// on: a page with no banner must come out of the second attempt exactly as it went in.
test('a page with no banner at all is unchanged by the second attempt', async () => {
    const {first, consent, state} = await bothAttempts(URLS.bannerlessLink, {waitMs: 0});
    assert.deepEqual(consent, {...first, arrivedLate: false});
    assert.equal(state.url, URLS.bannerlessLink, 'and the OK link is still not clicked');
    assert.equal(state.heading, 'THIS IS THE HOMEPAGE');
});

/* ----------------------------------------------- a banner inside a web component */

// The ancestor walk hits `parentElement === null` at the top of a shadow tree and stopped
// there, so an accept button sitting inside a `position: fixed` banner read as page
// furniture and was left alone. The positioning is on the HOST, in the light DOM, which is
// where a component ordinarily puts it and exactly what the walk could not reach.
test('an accept button inside a component is reached through the shadow boundary', async () => {
    const {consent, state} = await attempt(URLS.shadowBanner);
    assert.equal(consent.dismissed, true);
    assert.match(consent.via, /Accept all cookies/);
    assert.equal(state.bannerStillThere, false);
});

// The other half, and the more damaging one: a wall we cannot get past still has to be
// SEEN. `textContent` on a host returns its light DOM only — nothing — so the card is
// findable only by walking INTO the shadow root.
test('a consent card inside a component with no accept control is still seen', async () => {
    const {consent, state} = await attempt(URLS.shadowCard, {pinned: true});
    assert.equal(consent.bannerSeen, true, 'a banner in a component is still a banner');
    assert.equal(consent.dismissed, false, 'this one has no accept control, and is left alone');
    assert.equal(state.bannerStillThere, true, 'so it stays on the page and counts as surface area');
});

/* -------------------------------------------- a frame that never answers a question */

// THE THREE-MINUTE HANG, and the page the brief warned about. bakerandpartners.com has seven
// frames and one of them has an EMPTY URL; `page.evaluate` has no timeout of its own, so the
// search for a banner stopped on that frame for ever. Measured at HEAD, three runs out of
// three: `dismissConsent` had not returned after 120s, and the capture died at 3:00 with
// "dismissing a consent banner did not finish within 175945ms" and no artefacts at all.
test('a frame that never answers is given up on rather than waited out', async () => {
    const page = await open(URLS.hangingFrame, false);
    const at = Date.now();
    const finished = await Promise.race([
        dismissConsent(page, 250),
        new Promise((resolve) => setTimeout(() => resolve('STILL GOING'), 25000)),
    ]);
    const took = Date.now() - at;
    await page.close();
    assert.notEqual(finished, 'STILL GOING', `dismissConsent had not returned after ${took}ms`);
    assert.equal(finished.dismissed, false, 'there is no banner on this page');
    assert.equal(finished.bannerSeen, false, 'and a frame that cannot answer is skipped, not believed');
});
