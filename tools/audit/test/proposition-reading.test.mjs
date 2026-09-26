/**
 * PROPOSITION READING
 *
 *   node --test tools/audit/test/proposition-reading.test.mjs
 *
 * The judgements, from proposition.json and the page's purpose. No model runs here: the
 * same record gives the same findings every time, and every finding carries the facts it
 * was made from so a reader can check it.
 *
 * The records below are the real ones, cut down: boondmanager.com and kohde.agency as
 * captured on 25 Sep 2026, and gov.je for the purpose gate.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readProposition} from '../lib/proposition-reading.mjs';

const cta = (label, href, over = {}) => ({label, href, kind: 'internal', intent: 'sales', region: 'content',
    y: 600, pct: 6, firstScreen: true, pinned: false, ...over});

const BOOND = {
    measured: true,
    screen: 900,
    firstScreen: {answer: 'partly', says: [2], quotes: ['Boond libère le potentiel des ESN et sociétés de conseil grâce à des solutions boostées par l’IA.'], wordsToKnow: null, wordsOnScreen: 37},
    head: {answer: 'yes', sources: ['title', 'hidden heading'], title: 'Boond : Logiciel ERP pour ESN, SSII, cabinet de conseil | BoondManager',
        description: '', hiddenHeadings: ['Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS']},
    ctas: [
        cta('Demander une démo', 'https://www.boondmanager.com/demande-de-demo', {region: 'header', y: 15, pct: 0, pinned: true}),
        cta('Essayer', 'https://decouvrir.boondmanager.com/boond_demo/fr/', {region: 'header', y: 14, pct: 0, pinned: true, spoken: 'Demander une démo'}),
        cta('Demander une démo', 'https://www.boondmanager.com/demande-de-demo', {y: 589}),
        cta('Découvrir les offres', 'https://www.boondmanager.com/tarifs', {intent: 'explore', y: 4227, pct: 40, firstScreen: false}),
        cta('Demander une démo', 'https://www.boondmanager.com/demande-de-demo', {y: 7330, pct: 69, firstScreen: false}),
    ],
};

const KOHDE = {
    measured: true,
    screen: 900,
    firstScreen: {answer: 'yes', says: [1, 2], quotes: ['Kohde builds businesses with design', 'Start, scale or solve with a long-term B2B design partner across brand, web and product.'], wordsToKnow: 28, wordsOnScreen: 29},
    head: {answer: 'yes', sources: ['title'], title: 'Kohde — B2B design partner', description: '', hiddenHeadings: ['Why Kohde?']},
    ctas: [
        cta('Services', 'https://kohde.agency/services/', {intent: 'explore', y: 794}),
        cta('Get in touch', 'https://kohde.agency/contact/', {y: 5000, pct: 92, firstScreen: false}),
        cta('Contact us', 'https://kohde.agency/contact/', {region: 'footer', y: 5300, pct: 96, firstScreen: false}),
        cta('+44 (0)20 7490 0779', 'tel:+4402074900779', {kind: 'phone', region: 'footer', y: 5400, pct: 97, firstScreen: false}),
    ],
};

const enquire = {kind: 'enquire', confidence: 0.95};
const sell = {kind: 'sell', confidence: 0.9};
const ids = (reading) => reading.findings.map((f) => f.id);
const find = (reading, id) => reading.findings.find((f) => f.id === id);

test('boond: the first screen only partly says it, and the head says it instead', () => {
    const f = find(readProposition(BOOND, sell), 'first-screen');

    assert.equal(f.kind, 'gap');
    assert.match(f.text, /who it is for/);
    assert.match(f.text, /heading hidden from visitors/);
    assert.deepEqual(f.evidence.hiddenHeadings, ['Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS']);
    assert.deepEqual(f.evidence.quotes, BOOND.firstScreen.quotes);
});

test('kohde: the first screen says it, and the count is stated as a fact, not a verdict', () => {
    const f = find(readProposition(KOHDE, enquire), 'first-screen');

    assert.doesNotMatch(f.text, /\."\.$/, 'a quote that ends a sentence does not get a second full stop');
    assert.equal(f.kind, 'doing-its-job');
    assert.match(f.text, /28 words/);
    assert.equal(f.evidence.wordsToKnow, 28);
});

test('boond: an ask on the first screen, and one that stays on screen', () => {
    const r = readProposition(BOOND, sell);

    assert.equal(find(r, 'ask-first-screen').kind, 'doing-its-job');
    assert.equal(find(r, 'ask-reachable').kind, 'doing-its-job');
    assert.match(find(r, 'ask-reachable').text, /stays on screen/);
});

// SCREENS, NOT PERCENTAGES: halfway down a twenty-screen page is ten screens deep.
test('kohde: nothing on the first two screens, none pinned, and the first ask on screen 6', () => {
    const r = readProposition(KOHDE, enquire);

    assert.equal(find(r, 'ask-first-screen'), undefined, 'said once, by the finding that contains it');
    const reach = find(r, 'ask-reachable');
    assert.equal(reach.kind, 'gap');
    assert.match(reach.text, /first two screens/);
    assert.match(reach.text, /screen 6/);
    assert.equal(reach.evidence.nextScreen, 6);
});

// kohde.agency: the dot. Contact is one click away in a menu whose button never leaves the
// screen — not the same as nothing, and not the same as a visible ask either.
test('kohde: a sales ask behind a pinned menu button is named as that', () => {
    const record = {...KOHDE, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pct: 1, pinned: true})]};
    const r = readProposition(record, enquire);
    const reach = find(r, 'ask-reachable');

    assert.equal(reach.kind, 'gap');
    assert.match(reach.text, /behind the menu button/);
    assert.doesNotMatch(reach.text, /nothing stays on screen/, 'the menu button does stay: never say both');
    assert.match(reach.text, /"Contact"/);
    assert.equal(reach.evidence.behindMenu, 'Contact');
    assert.equal(find(r, 'ask-first-screen'), undefined, 'a hidden menu item is not a first-screen ask');
});

test('an ask on the second screen is within reach, and the empty first screen is still named', () => {
    const record = {...KOHDE, ctas: [cta('Get in touch', 'https://kohde.agency/contact/', {y: 1200, pct: 20, firstScreen: false})]};
    const r = readProposition(record, enquire);
    const reach = find(r, 'ask-reachable');

    assert.equal(find(r, 'ask-first-screen').kind, 'gap');

    assert.equal(reach.kind, 'doing-its-job');
    assert.match(reach.text, /second screen/);
});

test('an ask only on the third screen is not', () => {
    const record = {...KOHDE, ctas: [cta('Get in touch', 'https://kohde.agency/contact/', {y: 1850, pct: 30, firstScreen: false})]};
    const reach = find(readProposition(record, enquire), 'ask-reachable');

    assert.equal(reach.kind, 'gap');
    assert.equal(reach.evidence.nextScreen, 3);
});

test('with only a footer ask, it says so', () => {
    const record = {...KOHDE, ctas: [cta('Contact us', 'https://kohde.agency/contact/', {region: 'footer', y: 5300, firstScreen: false})]};

    assert.match(find(readProposition(record, enquire), 'ask-reachable').text, /until the footer/);
});

test('kohde: one destination under two labels is named, with both labels', () => {
    const f = find(readProposition(KOHDE, enquire), 'labels-/contact');

    assert.deepEqual(f.evidence.labels, ['Get in touch', 'Contact us']);
});

test('boond: a sales button that says one thing and tells screen readers another', () => {
    const f = find(readProposition(BOOND, sell), 'spoken-Essayer');

    assert.match(f.text, /"Essayer"/);
    assert.match(f.text, /"Demander une démo"/);
});

// abas-erp.com: "Contact" on screen and "CONTACT" in the DOM — one word in CSS capitals.
test('a difference of letter case is not a second label or a mismatch', () => {
    const record = {...KOHDE, ctas: [
        cta('Contact', 'https://abas-erp.com/fr/contact', {spoken: 'CONTACT', region: 'header', pinned: true}),
        cta('CONTACT', 'https://abas-erp.com/fr/contact', {region: 'footer', firstScreen: false}),
    ]};

    assert.equal(ids(readProposition(record, enquire)).some((id) => id.startsWith('labels-') || id.startsWith('spoken-')), false);
});

// wahio.design: "Cart" is announced "Open cart". The visible word is IN the spoken name,
// which is what WCAG 2.5.3 asks for; boond's "Essayer" announced as "Demander une démo" is not.
test('a spoken name that contains the visible label is fine', () => {
    const record = {...KOHDE, ctas: [cta('Cart', 'https://wahio.design/en/cart', {spoken: 'Open cart'})]};

    assert.equal(ids(readProposition(record, {kind: 'sell', confidence: 0.9})).some((id) => id.startsWith('spoken-')), false);
});

// wahio.design: twelve <button>s with no href were reported as one destination called "".
test('buttons without a destination are not one destination', () => {
    const record = {...KOHDE, ctas: [cta('Create My Own', ''), cta('Test My Idea', '')]};

    assert.equal(ids(readProposition(record, {kind: 'sell', confidence: 0.9})).some((id) => id.startsWith('labels-')), false);
});

test('a portal is not told it has no sales ask', () => {
    const r = readProposition(KOHDE, {kind: 'route', confidence: 0.97});

    assert.ok(ids(r).includes('first-screen'), 'what it does still applies');
    assert.equal(ids(r).some((id) => id.startsWith('ask-') || id.startsWith('labels-') || id.startsWith('spoken-')), false);
});

// vaiie.com: "Get Started" and "Contact" on the first screen, and a purpose that came back
// "unclear" in the audit and "enquire, 58%" on a re-run — under the floor both times, so the
// asks were never judged. Only a page we are SURE is not meant to ask is spared.
test('an unconfident purpose still has its asks judged, in neutral words', () => {
    for (const purpose of [{kind: 'unclear', confidence: 0}, {kind: 'enquire', confidence: 0.58}, null]) {
        const reach = find(readProposition(KOHDE, purpose), 'ask-reachable');

        assert.ok(reach, JSON.stringify(purpose));
        assert.match(reach.text, /asks visitors to act/, 'no guessing between buy and get in touch');
        assert.match(find(readProposition(KOHDE, purpose), 'get-in-touch').text, /get in touch/);
    }
});

test('a portal we are not sure of is judged too', () => {
    assert.ok(ids(readProposition(KOHDE, {kind: 'route', confidence: 0.4})).includes('ask-reachable'));
});

test('a confident publication is spared, like a portal', () => {
    assert.equal(ids(readProposition(KOHDE, {kind: 'publish', confidence: 0.9})).some((id) => id.startsWith('ask-')), false);
});

test('an ask whose intent had no majority is not counted either way', () => {
    const record = {...KOHDE, ctas: [cta('Talk to us', 'https://kohde.agency/talk', {intent: 'unknown'})]};
    const reach = find(readProposition(record, enquire), 'ask-reachable');

    assert.equal(reach.kind, 'gap', 'unknown is not a sales ask');
    assert.equal(reach.evidence.nextScreen, null);
    assert.match(reach.text, /no call to action at all/);
});

test('nothing is said when the first screen was never judged', () => {
    const record = {...KOHDE, firstScreen: {...KOHDE.firstScreen, answer: 'unknown'}};

    assert.equal(ids(readProposition(record, enquire)).includes('first-screen'), false);
});

test('an unmeasured record says nothing at all', () => {
    const r = readProposition({measured: false, why: 'boom'}, enquire);

    assert.equal(r.worth, false);
    assert.deepEqual(r.findings, []);
});

test('the same record reads the same every time', () => {
    assert.deepEqual(readProposition(BOOND, sell), readProposition(BOOND, sell));
});

// THE SCORE. Judgement constants, like the Technical and Brand scores in lib/pdf.mjs: half
// for saying what you do, half for the asks — on a page whose job is to ask.
import {propositionScore} from '../lib/proposition-reading.mjs';

test('score: clear and asking everywhere is 10', () => {
    const abas = {...KOHDE, firstScreen: {...KOHDE.firstScreen, answer: 'yes'}, ctas: [cta('Contact', 'https://abas-erp.com/fr/contact', {region: 'header', pinned: true})]};

    assert.equal(propositionScore(abas, enquire).score, 10);
});

test('score: kohde — clear, but no ask until screen 7 and only a menu in between', () => {
    const record = {...KOHDE, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true})]};
    const s = propositionScore(record, enquire);

    assert.deepEqual({clarity: s.clarity, firstAsk: s.firstAsk, reach: s.reach, touch: s.touch, penalties: s.penalties},
        {clarity: 10, firstAsk: 0, reach: 5, touch: 5, penalties: 1}, '/contact asked for as "Get in touch" and "Contact us"');
    assert.equal(s.score, 5.8, '5 + 0 + 0.75 + 1 - 1 = 5.75');
});

test('score: boond — partly says it, asks everywhere, one screen-reader mismatch', () => {
    const s = propositionScore(BOOND, sell);

    assert.deepEqual({clarity: s.clarity, firstAsk: s.firstAsk, reach: s.reach, touch: s.touch, penalties: s.penalties},
        {clarity: 5, firstAsk: 10, reach: 10, touch: 10, penalties: 1});
    assert.equal(s.score, 6.5, '2.5 + 1.5 + 1.5 + 2 - 1');
});

test('score: a portal is scored on what it says alone', () => {
    const s = propositionScore(KOHDE, {kind: 'route', confidence: 0.96});

    assert.equal(s.score, 10);
    assert.equal(s.asksJudged, false);
});

test('score: nothing is scored when the first screen was never judged', () => {
    assert.equal(propositionScore({...KOHDE, firstScreen: {...KOHDE.firstScreen, answer: 'unknown'}}, enquire), null);
    assert.equal(propositionScore({measured: false}, enquire), null);
});

import {askRows} from '../lib/proposition-reading.mjs';

// Jon's columns, 26 Sep 2026: Metric (the label) | Count | Where it goes | First seen.
test('rows: one per label and destination, counted, with where a visitor first meets it', () => {
    const rows = askRows({...KOHDE, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true})]});
    const row = (label) => rows.find((r) => r.label === label);

    assert.deepEqual(row('Get in touch'), {label: 'Get in touch', type: 'Conversion', count: 1, destination: '/contact', where: 'Screen 6'});
    assert.equal(row('Contact').where, 'Behind the menu');
    assert.equal(row('+44 (0)20 7490 0779').destination, 'Phone +4402074900779', 'no raw tel: in a report');
    assert.equal(row('+44 (0)20 7490 0779').where, 'Footer');
    assert.equal(rows.some((r) => r.label === 'Services'), false, 'exploration is not an ask');
});

test('rows: the same label to the same place is counted, and pinned says so on screen 1', () => {
    const rows = askRows(BOOND);
    const demo = rows.find((r) => r.label === 'Demander une démo');

    assert.equal(demo.count, 3, 'header, hero, and the band at 69%');
    assert.equal(demo.where, 'Screen 1 (stays on screen)');
    assert.equal(rows.find((r) => r.label === 'Essayer').where, 'Screen 1 (stays on screen)');
    const hero = askRows({...KOHDE, ctas: [cta('Book a call', 'https://kohde.agency/contact/')]});
    assert.equal(hero[0].where, 'Screen 1');
});

// boondmanager.com: its Solutions dropdown carries "Découvrez Boond Demander une démo" to
// /demande-de-demo, which is already pinned on screen. A menu row only adds something when
// the destination is not visible sooner — kohde.agency's "Contact" still shows, because its
// visible ask is on screen 7.
test('rows: a menu item is left out when its destination is already visible sooner', () => {
    const boond = askRows({...BOOND, ctas: [...BOOND.ctas,
        cta('Découvrez Boond Demander une démo', 'https://www.boondmanager.com/demande-de-demo', {region: 'menu', menu: 'Solutions', y: 15, pinned: true})]});
    assert.equal(boond.some((r) => r.where === 'Behind the menu'), false);

    const kohde = askRows({...KOHDE, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true})]});
    assert.ok(kohde.some((r) => r.label === 'Contact' && r.where === 'Behind the menu'));
});

// ---- the ask map and the fixes (26 Sep 2026) --------------------------------------------
import {askMap} from '../lib/proposition-reading.mjs';

test('map: one cell per screen, saying how a visitor can act there', () => {
    const record = {...KOHDE, pageHeight: 5500, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true})]};
    const map = askMap(record);

    assert.equal(map.length, 7, '5500px at 900px a screen');
    assert.deepEqual(map.map((c) => c.state), ['menu', 'menu', 'menu', 'menu', 'menu', 'ask', 'ask']);
    assert.deepEqual(map[5].asks, ['Get in touch', 'Contact us'], 'screen 6: y 5000 and 5300');
    assert.deepEqual(map[6].asks, ['+44 (0)20 7490 0779'], 'screen 7: y 5400');
});

test('map: a pinned ask covers every screen; a visible one on top of it still shows', () => {
    const map = askMap({...BOOND, pageHeight: 8100});

    assert.equal(map.length, 9);
    assert.ok(map.every((c) => c.state !== 'none' && c.state !== 'menu'));
    assert.equal(map[0].state, 'ask');
    assert.equal(map[3].state, 'pinned');
    assert.equal(map[8].state, 'ask', 'the band at y 7330 is on screen 9');
});

test('map: nothing to act on is none, and a page with no height has no map', () => {
    assert.deepEqual(askMap({...KOHDE, pageHeight: 1800, ctas: []}).map((c) => c.state), ['none', 'none']);
    assert.deepEqual(askMap({...KOHDE, pageHeight: null}), []);
});

test('fix: every gap carries one, in fixed words built from its own evidence', () => {
    const boond = readProposition(BOOND, sell).findings;
    const first = boond.find((f) => f.id === 'first-screen');
    assert.match(first.fix, /Put "Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS" on the first screen/);
    assert.match(boond.find((f) => f.id === 'spoken-Essayer').fix, /"Essayer"/);

    const kohde = readProposition({...KOHDE, ctas: [...KOHDE.ctas,
        cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true})]}, enquire).findings;
    assert.match(kohde.find((f) => f.id === 'ask-reachable').fix, /"Get in touch"/);
    assert.match(kohde.find((f) => f.id === 'labels-/contact').fix, /one label/);

    for (const f of [...boond, ...kohde]) {
        if (f.kind === 'gap') assert.ok(f.fix, f.id);
        else assert.equal(f.fix, undefined, `no fix for what is working: ${f.id}`);
    }
});

test('fix: without a hidden heading, the page title is what to put on screen', () => {
    const record = {...BOOND, head: {...BOOND.head, sources: ['title'], hiddenHeadings: []}};

    assert.match(readProposition(record, sell).findings.find((f) => f.id === 'first-screen').fix, /Boond : Logiciel ERP pour ESN/);
});

// ---- the checks table and the verdict (26 Sep 2026) -------------------------------------
//
// Five rows, the same on every report so two reports read row by row: says what you do, an
// ask on the first screen, an ask within reach, one name per destination, screen readers.
// A confident portal or publication gets the first row only.
import {propositionChecks, propositionVerdict} from '../lib/proposition-reading.mjs';

const KOHDE_MENU = {...KOHDE, pageHeight: 5500, ctas: [
    cta('Get in touch', 'https://kohde.agency/contact/', {y: 5000, pct: 92, firstScreen: false}),
    cta('+44 (0)20 7490 0779', 'tel:+4402074900779', {kind: 'phone', region: 'footer', y: 5400, pct: 97, firstScreen: false}),
    cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', menu: 'Toggle menu', y: 56, pinned: true}),
]};
const row = (checks, id) => checks.find((c) => c.id === id);

test('checks: kohde, row by row', () => {
    const c = propositionChecks(KOHDE_MENU, enquire);

    assert.deepEqual(c.map((x) => x.id), ['says', 'ask-first-screen', 'ask-reachable', 'get-in-touch', 'one-name', 'screen-readers']);
    assert.deepEqual(c.map((x) => x.status), ['working', 'fix', 'fix', 'fix', 'working', 'working']);
    assert.equal(row(c, 'get-in-touch').found, 'Only behind the menu button');
    assert.equal(row(c, 'says').found, 'Said in the first 28 words a visitor reads');
    assert.equal(row(c, 'ask-first-screen').found, 'Only behind the menu button');
    assert.equal(row(c, 'ask-first-screen').fix, 'Put "Get in touch" on the first screen.');
    assert.equal(row(c, 'ask-reachable').found, 'First visible call to action on screen 6 of 7');
    assert.equal(row(c, 'ask-reachable').fix, 'Keep a call to action on screen as visitors scroll.');
    for (const x of c) assert.equal(x.status === 'working' ? x.fix : 'has one', x.status === 'working' ? null : 'has one', x.id);
});

test('checks: boond, row by row', () => {
    const c = propositionChecks({...BOOND, pageHeight: 8100}, sell);

    assert.deepEqual(c.map((x) => x.status), ['fix', 'working', 'working', 'working', 'working', 'fix']);
    assert.equal(row(c, 'says').found, 'Only in a heading hidden from visitors');
    assert.match(row(c, 'says').fix, /^Put "Logiciel ERP ESN/);
    assert.equal(row(c, 'ask-first-screen').found, '"Demander une démo" and "Essayer"', 'the fixture has no "Essayer maintenant"');
    assert.equal(row(c, 'ask-reachable').found, '"Demander une démo" stays on screen as visitors scroll');
    assert.equal(row(c, 'screen-readers').found, '"Essayer" is announced as "Demander une démo"');
});

test('checks: one name per destination fails with the destination and its names', () => {
    const c = propositionChecks(KOHDE, enquire);

    assert.equal(row(c, 'one-name').status, 'fix');
    assert.equal(row(c, 'one-name').found, '/contact is "Get in touch" and "Contact us"');
});

test('checks: a confident portal gets the first row only', () => {
    assert.deepEqual(propositionChecks(KOHDE, {kind: 'route', confidence: 0.96}).map((x) => x.id), ['says']);
});

test('verdict: one sentence built from the checks, in fixed words', () => {
    assert.equal(propositionVerdict(KOHDE_MENU, enquire),
        'Clear about what you do. Hard to act on: no call to action until screen 6, unless a visitor opens the menu.');
    assert.equal(propositionVerdict({...BOOND, pageHeight: 8100}, sell),
        'Says who it is for, not what you sell. Easy to act on, with one fix.');
    assert.equal(propositionVerdict(KOHDE, {kind: 'route', confidence: 0.96}), 'Clear about what you do.');
    assert.equal(propositionVerdict({...KOHDE, firstScreen: {...KOHDE.firstScreen, answer: 'unknown'}}, enquire), null);
});

test('checks: the rows are named as the report prints them', () => {
    assert.deepEqual(propositionChecks(KOHDE_MENU, enquire).map((x) => x.check),
        ['Says what you do', 'Call to action on the first screen', 'Call to action within reach', 'Way to get in touch', 'Consistent button labels', 'Screen readers']);
});

// ---- the Competitor Benchmark's row (26 Sep 2026) ---------------------------------------
import {firstCallToAction} from '../lib/proposition-reading.mjs';

test('first call to action: the one fact the benchmark sets side by side', () => {
    assert.equal(firstCallToAction({...BOOND, pageHeight: 8100}, sell), 'Screen 1 (sticky)');
    assert.equal(firstCallToAction(KOHDE_MENU, enquire), 'Screen 6');
    assert.equal(firstCallToAction({...KOHDE, ctas: [cta('Book', 'https://kohde.agency/contact/')]}, enquire), 'Screen 1');
    assert.equal(firstCallToAction({...KOHDE, ctas: [cta('Contact', 'https://kohde.agency/contact/', {region: 'menu', pinned: true, y: 56})]}, enquire), 'Only through the menu');
    assert.equal(firstCallToAction({...KOHDE, ctas: []}, enquire), 'None');
    assert.equal(firstCallToAction(KOHDE, {kind: 'route', confidence: 0.96}), null, 'a portal is not judged on it');
});

// bedellcristin.com, 26 Sep 2026: its only call to action is "Contact Us" in the footer, and
// the summary said "nothing to click at all" — wrong about the footer, and wrong about a page
// full of links. The benchmark printed "None" for the same page.
test('verdict and benchmark: a footer-only call to action is said as the footer', () => {
    const bedell = {...KOHDE, pageHeight: 5230, ctas: [
        cta('Meet our people', 'https://www.bedellcristin.com/people/', {intent: 'explore'}),
        cta('Contact Us', 'https://www.bedellcristin.com/contact-us/', {region: 'footer', y: 4650, pct: 89, firstScreen: false}),
    ]};

    assert.equal(propositionVerdict(bedell, enquire), 'Clear about what you do. Hard to act on: no call to action until the footer.');
    assert.equal(firstCallToAction(bedell, enquire), 'Footer');
    assert.equal(propositionVerdict({...bedell, ctas: []}, enquire), 'Clear about what you do. Hard to act on: no call to action anywhere on the page.');
});

// bedellcristin.com, 26 Sep 2026: "Meet our people" and "Explore our services" in the hero,
// "Contact Us" only in the footer. The routing calls to action count as calls to action —
// half marks, because the sales ask is preferred — and the missing contact is its own check.
test('bedell: routing calls to action count, and the contact in the footer is still a warning', () => {
    const bedell = {...KOHDE, pageHeight: 5230, ctas: [
        cta('Meet our people', 'https://www.bedellcristin.com/people/', {intent: 'next', y: 700}),
        cta('Explore our services', 'https://www.bedellcristin.com/services/', {intent: 'next', y: 760}),
        cta('Contact Us', 'https://www.bedellcristin.com/contact-us/', {region: 'footer', y: 4650, pct: 89, firstScreen: false}),
    ]};
    const c = propositionChecks(bedell, enquire);

    assert.deepEqual(c.map((x) => [x.id, x.status]).slice(1, 4), [['ask-first-screen', 'working'], ['ask-reachable', 'working'], ['get-in-touch', 'fix']]);
    assert.equal(row(c, 'get-in-touch').found, 'Only in the footer: "Contact Us"');
    assert.equal(propositionVerdict(bedell, enquire), 'Clear about what you do. Easy to explore, but the only way to get in touch is in the footer.');
    assert.equal(propositionScore(bedell, enquire).score, 6.5, '5 + 0.75 + 0.75 + 0');
    assert.deepEqual(askRows(bedell).map((r) => [r.label, r.type]),
        [['Meet our people', 'Routing'], ['Explore our services', 'Routing'], ['Contact Us', 'Conversion']]);
});

test('consistent labels compares conversion asks only, not routing links to one page', () => {
    const record = {...KOHDE, ctas: [
        cta('Explore our services', 'https://www.bedellcristin.com/services/', {intent: 'next'}),
        cta('View our services', 'https://www.bedellcristin.com/services/', {intent: 'next', y: 1200, firstScreen: false}),
        cta('Contact Us', 'https://www.bedellcristin.com/contact-us/'),
        cta("Let's talk", 'https://www.bedellcristin.com/contact-us/', {y: 5000, firstScreen: false}),
    ]};
    const labels = readProposition(record, enquire).findings.filter((f) => f.id.startsWith('labels-')).map((f) => f.evidence.destination);

    assert.deepEqual(labels, ['/contact-us']);
});

test('rows: a form button with no link is in the table, so it agrees with the checklist', () => {
    const record = {...KOHDE, ctas: [cta('Submit', '', {intent: 'signup', y: 5119, firstScreen: false}),
        cta('Get in touch', 'https://kohde.agency/contact/', {y: 5570, firstScreen: false})]};

    assert.deepEqual(askRows(record).map((r) => [r.label, r.destination, r.where]),
        [['Submit', 'Form on the page', 'Screen 6'], ['Get in touch', '/contact', 'Screen 7']]);
});
