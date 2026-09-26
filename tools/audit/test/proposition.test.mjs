/**
 * PROPOSITION
 *
 *   node --test tools/audit/test/proposition.test.mjs
 *   AUDIT_LIVE=1 node --test tools/audit/test/proposition.test.mjs   # plus boondmanager.com
 *
 * Collection only: what the first screen says, what the <head> says, and every ask on the
 * page with where it goes. Nothing here decides what goes in a report.
 *
 * THE PAGE BELOW IS BOONDMANAGER.COM'S SHAPE, measured by hand on 25 Sep 2026:
 *
 *   - the H1 that says what they sell is visually hidden (1x1, clipped) and the visible
 *     headline is a slogan;
 *   - a header that stays on screen carries the demo ask, and a dropdown in it carries a
 *     second copy that is not visible until opened;
 *   - the hero has two asks, and everything after it is exploration.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    COLLECT_PROPOSITION,
    destinationKind,
    parsePropositionReply,
    combineReplies,
    wordsToKnow,
    buildProposition,
} from '../lib/proposition.mjs';
import {SHADOW_INIT} from '../lib/shadow.mjs';

const BOOND_SHAPE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Boond : Logiciel ERP pour ESN | BoondManager</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  header { position: sticky; top: 0; height: 64px; background: #fff; display: flex; gap: 16px; align-items: center; z-index: 2; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(1px, 1px, 1px, 1px); white-space: nowrap; }
  .menu { position: relative; }
  .menu .panel { position: absolute; top: 40px; visibility: hidden; }
  .hero { height: 700px; text-align: center; }
  .hero h2 { font-size: 64px; margin: 80px 0 16px; }
  section { height: 900px; }
  .reveal { opacity: 0; }
  .dot { width: 24px; height: 24px; border-radius: 50%; }
  .webflow-sr { position: absolute; width: 300px; clip-path: inset(0px 0px 99.9% 99.9%); }
  .tw-sr { position: absolute; top: 0; left: 0; padding: 8px 16px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .word { display: inline-block; }
  .slider { overflow: hidden; width: 300px; white-space: nowrap; }
  .slide { display: inline-block; width: 300px; }
  .overlay-button { position: relative; padding: 8px 16px; }
  .overlay-button .cover { position: absolute; inset: 0; }
  .badge { position: relative; display: inline-block; }
  .badge .cover-badge { position: absolute; top: 0; left: 0; width: 120px; height: 40px; }
</style></head><body>
<a class="tw-sr" href="#main">Skip to main content</a>
<header>
  <a href="/">Boond</a>
  <p class="tagline">ERP for consulting firms</p>
  <nav><div class="menu-label">Produits</div><a href="/tarifs">Tarifs</a>
    <div class="menu"><button>Solutions</button>
      <div class="panel"><a href="/demande-de-demo">Découvrez Boond — Demander une démo</a></div></div>
  </nav>
  <a href="https://ui.boondmanager.com/login">Espace client</a>
  <a href="/demande-de-demo">Demander une démo</a>
  <button class="dot" aria-label="Toggle menu" aria-controls="main-menu" aria-expanded="false"></button>
  <div id="main-menu" hidden><a href="/contact/">Contact</a><a href="/work/"><span>Work</span><span>Case studies</span></a></div>
  <button class="dot" aria-label="Toggle menu" aria-controls="main-menu" aria-expanded="false"></button>
  <button aria-label="Next slide" aria-controls="slides">›</button>
  <div id="slides" hidden><a href="/more">En savoir plus</a></div>
  <div class="overlay-button"><div class="face">Essayer</div>
    <a class="cover" href="https://decouvrir.boondmanager.com/boond_demo/fr/"><span class="sr-only">Demander une démo</span></a></div>
</header>
<h1 class="sr-only">Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS</h1>
<h2 class="webflow-sr">Boond's own words, hidden the way its CMS does it</h2>
<div class="hero">
  <h2><span class="word">Work</span> <span class="word">Smart,</span> <span class="word">Grow</span> <span class="word">Fast.</span></h2>
  <p>Boond libère le potentiel des ESN et sociétés de conseil grâce à des solutions boostées par l'<em>IA</em><span>.</span></p>
  <a href="/demande-de-demo">Demander une démo</a>
  <a href="https://decouvrir.boondmanager.com/boond_demo/fr/dashboard.html">Essayer maintenant</a>
  <a href="#main" aria-label="Aller au contenu"><svg width="20" height="20"></svg></a>
</div>
<section><div class="slider"><div class="slide"><h3>Slide one</h3></div><div class="slide"><h3>Slide two</h3></div></div>
<h2>Des offres pensées selon vos besoins</h2><a href="/tarifs">Découvrir les offres</a></section>
<section><div class="badge"><img width="120" height="40" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span>4.7</span>
  <a class="cover-badge" href="https://apps.apple.com/fr/app/boond"><span class="sr-only">Télécharger dans l'App Store</span></a></div></section>
<section><h2>Le Blog</h2><a href="/blog/un-article">Lire l'article</a><a href="/blog/deux">Lire l'article</a></section>
<section class="reveal"><a href="/demande-de-demo">Never painted</a></section>
<footer><a href="mailto:contact@boondmanager.com">Nous écrire</a></footer>
</body></html>`;

let server;
let base;
let browser;
let page;

test.before(async () => {
    server = createServer((_, res) => res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(BOOND_SHAPE));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
    page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.addInitScript(SHADOW_INIT);
    await page.goto(base, {waitUntil: 'load'});
});

test.after(async () => {
    await browser?.close();
    server?.close();
});

const collect = () => page.evaluate(COLLECT_PROPOSITION, {screen: 900, settleMs: 0});

test('a visually hidden heading is recorded, and recorded as hidden', async () => {
    const {headings} = await collect();
    const h1 = headings.find((h) => h.level === 1);

    assert.equal(h1.text, 'Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS');
    assert.equal(h1.visible, false);
    assert.equal(h1.hiddenWhy, 'sr-only');
    assert.equal(headings.find((h) => h.text === 'Work Smart, Grow Fast.').visible, true);
    assert.equal(headings.find((h) => /hidden the way its CMS/.test(h.text)).hiddenWhy, 'sr-only',
        'inset(0px 0px 99.9% 99.9%), as boondmanager.com uses');
});

// wahio.design listed 36 "hidden" headings and gov.je 28: carousel slides scrolled out of
// their track, collapsed menus. Out of view is not hidden from people on purpose, and only
// the second is the finding — the words a page gives Google and not its visitors.
test('a heading out of a carousel view is not a screen-reader-only heading', async () => {
    const {headings} = await collect();
    const two = headings.find((h) => h.text === 'Slide two');

    assert.equal(two.visible, false);
    assert.equal(two.hiddenWhy, 'clipped');
});

test('the header ask stays on screen and the hero ask does not', async () => {
    const {controls} = await collect();
    const demo = controls.filter((c) => c.href.endsWith('/demande-de-demo'));
    const header = demo.find((c) => c.region === 'header');
    const hero = demo.find((c) => c.region === 'content');

    assert.equal(header.pinned, true);
    assert.equal(hero.pinned, false);
    assert.equal(hero.firstScreen, true);
});

test('a control nobody can see is not an ask', async () => {
    const {controls} = await collect();
    const labels = controls.map((c) => c.label);

    assert.equal(labels.some((l) => l.includes('Découvrez Boond')), false, 'the closed dropdown');
    assert.equal(labels.includes('Never painted'), false, 'opacity 0');
});

// Webflow's button: the face is a <div>, and a transparent link laid over it carries only
// screen-reader text — boondmanager.com's header "Essayer" says "Demander une démo" to a
// screen reader. The label is what a visitor sees; what is spoken is kept when it differs.
test('an overlay link is labelled by the button it covers', async () => {
    const {controls} = await collect();
    const essayer = controls.find((c) => c.href.includes('boond_demo/fr/'));

    assert.equal(essayer.label, 'Essayer');
    assert.equal(essayer.spoken, 'Demander une démo');
    assert.equal(controls.find((c) => c.label === 'Tarifs' && c.region === 'header').spoken, undefined,
        'nothing extra when they agree');
});

// boondmanager.com's App Store badge: the overlay covers the badge image, and the rating
// beside it is in the same wrapper. Borrowing the wrapper's words labelled it "4.7".
test('an overlay only borrows the words of a box it actually covers', async () => {
    const {controls} = await collect();

    assert.equal(controls.find((c) => c.href.includes('apps.apple.com')).label, "Télécharger dans l'App Store");
});

// kohde.agency's only navigation is a dot that stays on screen; Contact is inside the menu
// it opens, hidden until clicked. The menu is read through the button's aria-controls —
// without clicking anything — and what is in it is recorded as behind that button.
test('what a pinned menu button hides is recorded as behind it', async () => {
    const {menus, controls} = await collect();
    const menu = menus.find((m) => m.label === 'Toggle menu');

    assert.equal(menu.pinned, true);
    assert.deepEqual(menu.controls.map((c) => c.label), ['Contact', 'Work Case studies'],
        'words in separate elements are separate words ("Découvrez BoondDemander une démo")');
    assert.equal(controls.some((c) => c.label === 'Contact'), false, 'not a visible ask');
});

// boondmanager.com renders its header twice, and read every menu twice.
test('the same menu twice is one menu', async () => {
    const {menus} = await collect();

    assert.equal(menus.filter((m) => m.label === 'Toggle menu').length, 1);
});

// boondmanager.com's carousel arrows declare aria-controls too. A menu button says whether
// it is open (aria-expanded); a carousel arrow does not.
test('a carousel arrow is not a menu button', async () => {
    const {menus} = await collect();

    assert.equal(menus.some((m) => m.controls.some((c) => c.label === 'En savoir plus')), false);
});

test('an icon link takes its name from aria-label', async () => {
    const {controls} = await collect();

    assert.ok(controls.some((c) => c.label === 'Aller au contenu'));
});

test('the page is walked back to the top afterwards', async () => {
    await collect();

    assert.equal(await page.evaluate(() => window.scrollY), 0);
});

// gov.je says what it is in a tagline beside its logo — "Information and public services for
// the Island of Jersey" — and dropping all header text took it out of the question. Only the
// header's links and buttons are navigation; any other words in it are read like the rest.
test('first-screen lines keep a header tagline and leave the navigation out', async () => {
    const {firstScreen} = await collect();
    const read = firstScreen.filter((l) => !(l.inHeader && l.inNav)).map((l) => l.text);

    assert.equal(read[0], 'ERP for consulting firms', 'the tagline, read first');
    assert.equal(read.includes('Tarifs'), false, 'a header link is navigation');
    assert.equal(read.includes('Produits'), false, 'so is a menu label in a <nav>, link or not (abas-erp.com)');
    assert.equal(read.some((t) => /Skip to main/.test(t)), false, 'Tailwind sr-only: clip-path inset(50%) (wahio.design)');
    const content = read.slice(1);

    assert.equal(content[0], 'Work Smart, Grow Fast.', 'one line, though every word is its own box (kohde.agency)');
    assert.match(content[1], /^Boond libère le potentiel/);
    assert.match(content[1], /par l'IA\.$/, 'no space before punctuation from its own element (vaiie.com: "One platform .")');
    assert.ok(firstScreen.some((l) => l.inHeader && l.inControl && l.text === 'Tarifs'), 'kept, but flagged');
    assert.equal(content.some((t) => t.startsWith('Logiciel ERP')), false, 'the hidden H1 is not on screen');
});

test('destinations are sorted by what they ask of a visitor', () => {
    const at = 'https://www.boondmanager.com/';
    const cases = {
        'mailto:hello@a.com': 'email',
        'tel:+33123': 'phone',
        'https://www.boondmanager.com/#main': 'same-page',
        '#pricing': 'same-page',
        'https://calendly.com/boond/demo': 'booking',
        'https://meetings.hubspot.com/x': 'booking',
        'https://ui.boondmanager.com/login': 'account',
        'https://www.boondmanager.com/demande-de-demo': 'internal',
        'https://www.capterra.fr/software/1': 'external',
        '': 'none',
    };
    for (const [href, kind] of Object.entries(cases)) {
        assert.equal(destinationKind(href, at), kind, href);
    }
});

test('words to know counts everything read up to the line that says it', () => {
    const lines = [
        {n: 1, text: 'Work Smart, Grow Fast.'},
        {n: 2, text: 'We build accounting software for dentists.'},
        {n: 3, text: 'Book a demo'},
    ];

    assert.equal(wordsToKnow(lines, [2]), 10);
    assert.equal(wordsToKnow(lines, [1, 2]), 10);
    assert.equal(wordsToKnow(lines, []), null, 'never said is not zero');
});

test('a reply is made safe: unknown labels and invented numbers are dropped', () => {
    const got = parsePropositionReply(
        '{"lines":{"1":"offer","2":"shouting","99":"offer"},"head":"yes","headSources":["title","nonsense"],'
        + '"ctas":{"1":"service","2":"shouting","7":"explore"}}',
        {lines: 3, ctas: 2},
    );

    assert.deepEqual(got.lines, {1: 'offer', 2: 'unknown', 3: 'unknown'});
    assert.equal(got.head, 'yes');
    assert.deepEqual(got.headSources, ['title']);
    assert.deepEqual(got.ctas, {1: 'service', 2: 'unknown'});
    assert.deepEqual(parsePropositionReply('no json here', {lines: 1, ctas: 0}).lines, {});
});

test('the record quotes the page, not the model, and groups asks by destination', async () => {
    const collected = await collect();
    const meta = {capturedUrl: base, head: {title: 'Boond : Logiciel ERP pour ESN'}, fullHeight: 3600, proposition: collected};
    const record = buildProposition(meta, {
        lines: {1: 'other', 2: 'other', 3: 'context'},
        head: 'yes',
        headSources: ['title', 'hidden heading'],
        ctas: {},
    });

    assert.equal(record.firstScreen.answer, 'partly', 'context and no offer');
    assert.match(record.firstScreen.quotes[0], /^Boond libère le potentiel/);
    assert.equal(record.firstScreen.wordsToKnow, null, 'never told what it is');
    assert.equal(record.firstScreen.lines[0].text, 'ERP for consulting firms', 'the model is shown the tagline');
    assert.deepEqual(record.head.hiddenHeadings, [
        'Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS',
        "Boond's own words, hidden the way its CMS does it",
    ], 'the screen-reader-only ones, and not the carousel slide');

    const demo = record.destinations.find((d) => d.href.endsWith('/demande-de-demo'));
    assert.deepEqual(demo.labels, ['Demander une démo']);
    assert.equal(demo.pinned, true);
    assert.equal(demo.firstScreen, true);
});

test('menu items become asks that are behind the menu, not on the page', () => {
    const record = buildProposition({capturedUrl: 'https://kohde.agency/', proposition: {headings: [], firstScreen: [], controls: [],
        menus: [{label: 'Toggle menu', y: 56, firstScreen: true, pinned: true, controls: [{label: 'Contact', href: 'https://kohde.agency/contact/'}]}]}},
    {lines: {}, head: 'yes', headSources: [], ctas: {1: 'sales'}});
    const contact = record.ctas.find((c) => c.label === 'Contact');

    assert.equal(contact.region, 'menu');
    assert.equal(contact.menu, 'Toggle menu');
    assert.equal(contact.intent, 'sales', 'asked about like any other control');
    assert.equal(contact.pinned, true);
});

test('two copies of the same control in the same place are one ask', () => {
    const twin = {label: 'Demander une démo', href: 'https://a.com/demo', region: 'header', x: 10, y: 15, w: 171, h: 35, firstScreen: true, pinned: true};
    const record = buildProposition({capturedUrl: 'https://a.com/', proposition: {controls: [twin, {...twin}], headings: [], firstScreen: []}}, null);

    assert.equal(record.ctas.length, 1);
});

// THE SAME PAGE ASKED THREE TIMES gave gov.je "partly/yes/yes" and gov.gg's words-to-know
// as 37/30/8 (25 Sep 2026, stability.mjs). One answer is a sample; the record keeps what a
// majority agrees on and says "unknown" where there is none.
test('votes: each line keeps the label most voters gave it', () => {
    const r = (lines) => ({lines, head: 'yes', headSources: ['title'], ctas: {}});
    const got = combineReplies([
        r({1: 'other', 2: 'offer', 3: 'context'}),
        r({1: 'other', 2: 'offer', 3: 'offer'}),
        r({1: 'context', 2: 'context', 3: 'other'}),
    ]);

    assert.deepEqual(got.lines, {1: 'other', 2: 'offer', 3: 'unknown'});
});

// The verdict and the word count are the CODE's, from the agreed labels, so the model is
// never asked to choose how much counts — which is where gov.gg's 37/30/8 came from.
test('the verdict and words to know follow from the line labels', () => {
    const meta = {capturedUrl: 'https://a.com/', proposition: {headings: [], controls: [], firstScreen: [
        {text: 'Work smart', y: 0}, {text: 'For dental practices everywhere', y: 50},
        {text: 'Accounting software for dentists', y: 100}, {text: 'Book a demo', y: 150},
    ]}};
    const build = (lines) => buildProposition(meta, {lines, head: 'yes', headSources: [], ctas: {}}).firstScreen;

    const yes = build({1: 'other', 2: 'context', 3: 'offer', 4: 'other'});
    assert.equal(yes.answer, 'yes');
    assert.equal(yes.wordsToKnow, 2 + 4 + 4);
    assert.deepEqual(yes.quotes, ['For dental practices everywhere', 'Accounting software for dentists']);

    assert.equal(build({1: 'other', 2: 'context', 3: 'other', 4: 'other'}).answer, 'partly');
    assert.equal(build({1: 'other', 2: 'other', 3: 'other', 4: 'other'}).answer, 'no');
    assert.equal(buildProposition(meta, null).firstScreen.answer, 'unknown');
});

test('votes: each ask keeps the intent most voters gave it', () => {
    const r = (ctas) => ({lines: {}, head: 'yes', headSources: [], ctas});
    const got = combineReplies([r({1: 'sales', 2: 'service'}), r({1: 'sales', 2: 'explore'}), r({1: 'explore', 2: 'sales'})]);

    assert.deepEqual(got.ctas, {1: 'sales', 2: 'unknown'});
});

test('votes: fewer than two answers is no answer', () => {
    assert.equal(combineReplies([null, null, {lines: {}, head: 'yes', headSources: [], ctas: {}}]), null);
});

test('a booking tool is a sales ask and a login is an account, whatever the model said', async () => {
    const meta = {capturedUrl: 'https://a.com/', proposition: {headings: [], firstScreen: [], controls: [
        {label: 'Chat to us', href: 'https://calendly.com/a/intro', region: 'content', x: 0, y: 10, w: 10, h: 10},
        {label: 'Client area', href: 'https://app.a.com/login', region: 'header', x: 0, y: 0, w: 10, h: 10},
    ]}};
    const record = buildProposition(meta, {lines: {}, head: 'yes', headSources: [], ctas: {1: 'explore', 2: 'sales'}});

    assert.equal(record.ctas[0].intent, 'sales');
    assert.equal(record.ctas[1].intent, 'account');
});

test('a capture that could not collect says so rather than looking empty', () => {
    const record = buildProposition({proposition: {measured: false, why: 'boom'}}, null);

    assert.equal(record.measured, false);
    assert.equal(record.why, 'boom');
});

// THE HAND AUDIT, REPRODUCED. Costs a capture and one model call, so it only runs on ask.
test('boondmanager.com: the first screen only partly says what they sell', {skip: !process.env.AUDIT_LIVE}, async () => {
    const {capturePage} = await import('../lib/capture.mjs');
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const {readFileSync} = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'proposition-'));
    await capturePage('https://www.boondmanager.com', dir);
    await promisify(execFile)('node', ['tools/audit/proposition.mjs', dir]);
    const record = JSON.parse(readFileSync(join(dir, 'proposition.json'), 'utf8'));

    assert.equal(record.firstScreen.answer, 'partly');
    assert.equal(record.head.answer, 'yes');
    assert.ok(record.head.hiddenHeadings.some((h) => /ERP/.test(h)));
    // THE HAND AUDIT WAS WRONG HERE. It said nothing between the hero and the footer asks
    // for anything; the collector found the "Testez l'expérience." band at ~69%, whose
    // button is an overlay link with no visible text of its own — checked against the
    // capture's own screenshot. One ask after the hero, not none.
    const afterHero = record.ctas.filter((c) => c.intent === 'sales' && !c.pinned && c.region === 'content' && !c.firstScreen);
    assert.deepEqual(afterHero.map((c) => c.label), ['Demander une démo']);
    assert.ok(afterHero[0].pct > 60 && afterHero[0].pct < 80, String(afterHero[0].pct));
    const essayer = record.ctas.find((c) => c.region === 'header' && c.label === 'Essayer');
    assert.equal(essayer?.spoken, 'Demander une démo');
});

// THE CLI, END TO END, WITHOUT THE MODEL: a stored answer keyed to the same input is replayed,
// and the reading, score and table are patched into report.json beside what was there.
test('the step patches its reading into report.json and keeps what was there', async () => {
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const {writeFileSync, readFileSync} = await import('node:fs');
    const {inputHash} = await import('../lib/proposition.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'proposition-cli-'));
    const meta = {
        url: 'https://kohde.agency', capturedUrl: 'https://kohde.agency/', fullHeight: 5500, head: {title: 'Kohde'},
        proposition: {measured: true, screen: 900, headings: [], menus: [],
            firstScreen: [{text: 'A B2B design agency', x: 0, y: 300, inHeader: false, inControl: false, inNav: false}],
            controls: [{label: 'Get in touch', href: 'https://kohde.agency/contact/', region: 'content', x: 0, y: 5000, w: 10, h: 10, firstScreen: false, pinned: false}]},
    };
    const reply = {lines: {1: 'offer'}, head: 'yes', headSources: ['title'], ctas: {1: 'sales'}};
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'proposition.json'), JSON.stringify({inputHash: inputHash(meta), reply, votes: [reply], askedAt: 'then'}));
    writeFileSync(join(dir, 'report.json'), JSON.stringify({url: meta.url, purpose: {kind: 'enquire', confidence: 0.95}}));

    await promisify(execFile)('node', ['tools/audit/proposition.mjs', dir]);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));

    assert.equal(report.purpose.kind, 'enquire', 'what was there is kept');
    assert.equal(report.proposition.score.score, 5, 'says it (10 x 0.5), no first-screen ask, nothing within reach');
    assert.equal(report.proposition.firstScreen.answer, 'yes');
    assert.deepEqual(report.proposition.asks, [{label: 'Get in touch', type: 'Conversion', count: 1, destination: '/contact', where: 'Screen 6'}]);
    assert.ok(report.proposition.findings.some((f) => f.id === 'ask-reachable' && f.kind === 'gap'));
});
