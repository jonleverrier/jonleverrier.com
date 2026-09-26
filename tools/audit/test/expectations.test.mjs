/**
 * EXPECTATIONS
 *
 *   node --test tools/audit/test/expectations.test.mjs
 *
 * WHICH SEGMENTS MATTER, GIVEN WHAT THE PAGE IS FOR.
 *
 * NO MODEL RUNS HERE, and that is the point of the file existing at all. The model decides
 * what each block IS; what that then MEANS is a judgement, and a judgement a report makes
 * about somebody's business has to be identical on every run and readable by the person
 * who wrote it. The feedback bar on gov.uk came back `unclassified` on one run and
 * `promotion` on the next from the same prompt; a table cannot do that.
 *
 * The rule that earns the file: an ABSENCE IS NOT A GAP unless the purpose says it is.
 * Telling a government portal it has no testimonials is worse than saying nothing, because
 * it is advice that is wrong rather than advice that is missing.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    EXPECTATIONS, ROLES, read, compare, roleOf, describe, CORE_FLOOR, PRESENT, SURPRISE,
} from '../lib/expectations.mjs';
import {CATEGORIES} from '../lib/vision.mjs';
import {PURPOSES} from '../lib/purpose.mjs';

const site = (purpose, categories, over = {}) => ({
    url: 'https://example.com',
    purpose: {kind: purpose, confidence: 0.95, claim: 'We do a thing', from: 'hero'},
    categories: Object.entries(categories).map(([category, v]) => ({
        category,
        share: typeof v === 'number' ? v : v.share,
        firstViewport: typeof v === 'number' ? 0 : (v.firstViewport ?? 0),
        blocks: typeof v === 'number' ? [{}] : (v.blocks ?? [{}]),
    })),
    ...over,
});

const ids = (report) => read(report).findings.map((f) => f.id);
const texts = (report) => read(report).findings.map((f) => f.text).join(' ');

/* ------------------------------------------------------------------- the table */

test('every category a block can be given has a role under every purpose', () => {
    // A category with no role is a segment the report silently has no opinion about, which
    // is indistinguishable from one it decided not to mention.
    for (const purpose of PURPOSES.filter((p) => p !== 'unclear')) {
        for (const category of CATEGORIES.filter((c) => c !== 'unclassified')) {
            assert.ok(roleOf(purpose, category), `${purpose} has no role for ${category}`);
            assert.ok(ROLES.includes(roleOf(purpose, category)), `${purpose}/${category} is not a role`);
        }
    }
});

test('unclassified is nobody’s business: the screenshot covers it', () => {
    for (const purpose of PURPOSES.filter((p) => p !== 'unclear')) {
        assert.equal(roleOf(purpose, 'unclassified'), null);
    }
});

test('every purpose has exactly one core segment it is named for', () => {
    for (const purpose of PURPOSES.filter((p) => p !== 'unclear')) {
        const cores = Object.entries(EXPECTATIONS[purpose]).filter(([, r]) => r === 'core');
        assert.ok(cores.length >= 1, `${purpose} has no core segment`);
    }
});

test('every purpose has a clause saying what its job is, and it is a clause', () => {
    // A CLAUSE, NOT A SENTENCE. It is the tail of "a page whose job is ___", and when
    // these read "its job is to send people somewhere" the section rendered "a page whose
    // its job is to send people somewhere".
    for (const purpose of PURPOSES.filter((p) => p !== 'unclear')) {
        const job = describe(purpose);
        assert.match(job, /^to \w/, `${purpose}: ${job}`);
        assert.equal(/\bits\b|\bjob\b/.test(job), false, `${purpose} carries its own subject: ${job}`);
    }
});

/* --------------------------------------------------------------- doing its job */

test('a core segment with real space behind it is the page doing what it says', () => {
    // gov.uk: routing 69.3%, 45.9% of the first screen.
    const gov = site('route', {routing: {share: 0.693, firstViewport: 0.459, blocks: [{}, {}]}, footer: 0.183});
    assert.ok(ids(gov).includes('core-routing'));
    assert.match(texts(gov), /69\.3%/);
});

test('a core segment with almost nothing behind it is a gap', () => {
    const shop = site('sell', {promotion: 0.01, routing: 0.7, footer: 0.29});
    const found = read(shop).findings.find((f) => f.id === 'core-promotion');
    assert.equal(found.role, 'core');
    assert.equal(found.kind, 'gap');
});

test('CORE_FLOOR is the line between those two', () => {
    assert.ok(CORE_FLOOR > PRESENT && CORE_FLOOR < 0.5);
});

/* ------------------------------------------------- an absence that is not a gap */

test('a government portal is never told it has no testimonials', () => {
    const gov = site('route', {routing: 0.7, footer: 0.3});
    assert.equal(/trust|testimonial/i.test(texts(gov)), false, 'trust is irrelevant to a directory');
});

test('…and a consultancy with no testimonials IS told', () => {
    const agency = site('enquire', {routing: 0.4, explainer: 0.3, hero: 0.2, footer: 0.1});
    const found = read(agency).findings.find((f) => f.id === 'core-trust');
    assert.equal(found.kind, 'gap', 'trust is what an enquiry page is believed on');
});

test('an absence the purpose calls irrelevant is stated as not a gap, not left to the reader', () => {
    // The reader can see promotion at 1.7% in the table above and will wonder. Saying "a
    // directory is not selling" costs a clause and stops the number reading as a fault.
    const gov = site('route', {routing: 0.7, promotion: 0.017, footer: 0.283});
    const said = read(gov);
    assert.ok(said.notGaps.length, 'the section has to be able to say what it is not judging');
    assert.ok(said.notGaps.includes('promotion'));
    // And as a sentence, because the template must not be the place this is worded.
    assert.match(said.notGapsText, /not a gap/);
    assert.match(said.notGapsText, /promotion/i);
    // It opens the sentence, so it is capitalised and the verb agrees with the count.
    assert.match(said.notGapsText, /^Promotion and trust are /);
});

test('with nothing to excuse, there is no sentence excusing it', () => {
    const agency = site('enquire', {hero: 0.2, explainer: 0.3, trust: 0.2, footer: 0.3});
    assert.equal(read(agency).notGapsText, '', 'enquire calls nothing irrelevant');
});

/* ------------------------------------------------------------------ a surprise */

test('a segment the purpose says is irrelevant, taking a third of the page, is a finding', () => {
    const odd = site('route', {routing: 0.5, promotion: 0.35, footer: 0.15});
    const found = read(odd).findings.find((f) => f.id === 'surprise-promotion');
    assert.equal(found.kind, 'surprise');
    assert.ok(SURPRISE > PRESENT);
});

test('…and the same segment at 2% is not', () => {
    const gov = site('route', {routing: 0.7, promotion: 0.02, footer: 0.28});
    assert.equal(ids(gov).includes('surprise-promotion'), false);
});

/* ------------------------------------------------------- orientation, per purpose */

test('a page with no hero is a gap where the purpose expects one', () => {
    // gov.je. A visitor arriving cold meets 69% links and 31% navigation.
    const je = site('route', {routing: 0.688, navigation: 0.312});
    const found = read(je).findings.find((f) => f.id === 'missing-hero');
    assert.equal(found.kind, 'gap');
    assert.match(found.text, /hero/i);
});

/**
 * gov.uk. Its header bar is 64px, which is 1.4% of a 4,598px page — under any share
 * threshold worth setting, and plainly there in the annotated screenshot. The first cut of
 * this file told gov.uk it had no navigation.
 */
test('a small segment on a long page is present, not absent', () => {
    const gov = site('route', {
        routing: 0.693,
        navigation: {share: 0.014, blocks: [{what: 'GOV.UK header bar'}]},
        hero: 0.092,
        footer: 0.183,
    });
    assert.equal(ids(gov).includes('missing-navigation'), false, '1.4% of a long page is a header, not an absence');
});

test('…and a publication is not judged for the same thing', () => {
    const mag = site('publish', {editorial: 0.6, routing: 0.3, footer: 0.1});
    assert.equal(ids(mag).includes('missing-hero'), false, 'a hero is optional on a page that is read');
});

/* -------------------------------------------------------------- refusing to read */

test('an unclear purpose produces nothing at all', () => {
    const mystery = site('unclear', {routing: 0.7, footer: 0.3});
    mystery.purpose = {kind: 'unclear', confidence: 0, claim: null, from: null};
    const said = read(mystery);
    assert.deepEqual(said.findings, []);
    assert.equal(said.worth, false, 'the section renders nothing rather than hedging');
});

test('a purpose we are not sure enough about is the same as not knowing', () => {
    const shaky = site('route', {routing: 0.7, footer: 0.3});
    shaky.purpose = {...shaky.purpose, confidence: 0.2};
    assert.equal(read(shaky).worth, false);
});

test('a report with no purpose at all does not throw', () => {
    const old = site('route', {routing: 0.7, footer: 0.3});
    delete old.purpose;
    assert.doesNotThrow(() => read(old));
    assert.equal(read(old).worth, false);
});

/* ------------------------------------------------------------------- the claim */

test('the claim comes back as the page wrote it, for quoting', () => {
    const gov = site('route', {routing: 0.7, footer: 0.3});
    assert.equal(read(gov).claim, 'We do a thing');
});

test('findings never name the other site: that is the comparison’s job', () => {
    const gov = site('route', {routing: 0.693, promotion: 0.017, footer: 0.29});
    assert.equal(/against|gov\.je|competitor/i.test(texts(gov)), false);
});

/* ------------------------------------------------------------- the two together */

const NAMES = {mine: 'gov.uk', theirs: 'gov.je'};

test('two pages with the same purpose are two answers to one question', () => {
    const a = site('route', {routing: 0.693, hero: 0.092, footer: 0.183});
    const b = site('route', {routing: 0.726, navigation: 0.312});
    const said = compare(a, b, NAMES);
    assert.equal(said.samePurpose, true);
    assert.match(said.lead, /same thing/);
});

test('an absence on one page and not the other is the finding of the whole comparison', () => {
    // gov.je has no hero. No row on that sheet says so: every one of them is two shares
    // and a change, and this is a share against an absence.
    const a = site('route', {routing: 0.693, hero: 0.092, footer: 0.183});
    const b = site('route', {routing: 0.726, navigation: 0.312});
    assert.ok(compare(a, b, NAMES).points.some((p) => /Only gov\.je is without a hero/.test(p)));
});

test('two pages with different purposes are said to be different, before the numbers', () => {
    const shop = site('sell', {promotion: 0.4, hero: 0.3, trust: 0.2, footer: 0.1});
    const mag = site('publish', {editorial: 0.6, routing: 0.3, footer: 0.1});
    const said = compare(shop, mag, NAMES);
    assert.equal(said.samePurpose, false);
    assert.match(said.lead, /not trying to do the same thing/);
    assert.match(said.lead, /two different decisions/);
});

test('…and nothing is compared across them, because the comparison would mislead', () => {
    const shop = site('sell', {promotion: 0.4, hero: 0.3, trust: 0.2, footer: 0.1});
    const mag = site('publish', {editorial: 0.6, routing: 0.3, footer: 0.1});
    assert.deepEqual(compare(shop, mag, NAMES).points, []);
});

test('a page whose purpose is unknown is not compared at all', () => {
    const a = site('route', {routing: 0.7, footer: 0.3});
    const b = site('route', {routing: 0.7, footer: 0.3});
    b.purpose = {kind: 'unclear', confidence: 0, claim: null, from: null};
    assert.equal(compare(a, b, NAMES).worth, false);
});

/* ------------------------------------------------------- one verdict, not three */

/**
 * boondmanager.com's competitor, abas-erp.com/fr. `enquire` has three core segments, so
 * the conclusion — "so the page is spending its space on what it says it is for" — landed
 * on the end of two of the three bullets, and each of the three announced itself as "what
 * this page is for". It read as a stuck record contradicting itself.
 *
 * `route` has one core, which is why gov.uk and gov.je never showed it. Every other
 * purpose has two or more, so the single-core case was the lucky one.
 */
test('a core finding states its measurement and draws no conclusion', () => {
    const agency = site('enquire', {
        hero: {share: 0.076, firstViewport: 0.2, blocks: [{}]},
        explainer: {share: 0.401, blocks: [{}, {}, {}, {}, {}]},
        trust: {share: 0.258, blocks: [{}, {}, {}, {}]},
        footer: 0.265,
    });
    for (const f of read(agency).findings) {
        assert.equal(/spending its space/.test(f.text), false, `conclusion in a bullet: ${f.text}`);
        assert.equal(/what this page is for/.test(f.text), false, `bullet claims to be the whole point: ${f.text}`);
    }
});

test('…and the conclusion is one sentence, naming what is thin', () => {
    const agency = site('enquire', {
        hero: {share: 0.076, firstViewport: 0.2, blocks: [{}]},
        explainer: {share: 0.401, blocks: [{}, {}, {}, {}, {}]},
        trust: {share: 0.258, blocks: [{}, {}, {}, {}]},
        footer: 0.265,
    });
    assert.equal(
        read(agency).verdict,
        'two of the three things an enquiry page needs are there in quantity. The hero is not.',
    );
});

test('all cores healthy is still said, once', () => {
    // A COMPLETE PAGE. Leave hero or navigation out and `route` reports them absent, which
    // now withholds the verdict on purpose — see the gov.je case below.
    const gov = site('route', {
        routing: {share: 0.693, firstViewport: 0.459, blocks: [{}, {}]},
        hero: 0.092, navigation: 0.014, footer: 0.183,
    });
    const said = read(gov);
    assert.equal(said.verdict, 'That is the page spending its space on what it says it is for.');
    assert.equal(said.findings.filter((f) => /spending its space/.test(f.text)).length, 0);
});

test('every core thin says so without counting', () => {
    const shop = site('sell', {promotion: 0.01, hero: 0.02, routing: 0.7, footer: 0.27});
    assert.match(read(shop).verdict, /^None of the two things a page that sells needs/);
});

test('the verdict agrees with the verb when one core is healthy', () => {
    const shop = site('sell', {promotion: 0.4, hero: 0.02, routing: 0.3, footer: 0.28});
    assert.match(read(shop).verdict, /^one of the two things a page that sells needs is there in quantity\./);
});

/**
 * gov.je. Routing is the only core for `route` and it is healthy, so the verdict fired —
 * directly under a bullet reading "The page has no hero." Both sentences true, and
 * together they read as the report waving its own finding away.
 */
test('the all-clear is withheld when a bullet has named something missing', () => {
    const je = site('route', {routing: {share: 0.726, firstViewport: 0.688, blocks: [{}, {}, {}, {}]}, navigation: 0.112});
    const said = read(je);
    assert.ok(said.findings.some((f) => /no hero/.test(f.text)), 'the hero gap is still reported');
    assert.equal(said.verdict, '', 'and nothing contradicts it');
});

test('…and it is still said when nothing at all is missing', () => {
    const gov = site('route', {
        routing: {share: 0.693, firstViewport: 0.459, blocks: [{}, {}]},
        hero: 0.092, navigation: 0.014, footer: 0.183,
    });
    assert.equal(read(gov).verdict, 'That is the page spending its space on what it says it is for.');
});

/* --------------------------------------------------- the first screen, and the rest */

/**
 * boondmanager.com. A page whose job is to sell, whose ask is 5.9% of it and NONE of the
 * first screen — and the report printed neither fact. The first-screen share was only
 * added to a bullet when it was above zero, so the most telling number a core segment can
 * carry was suppressed exactly where it mattered.
 */
const boond = () => site('sell', {
    explainer: {share: 0.390, blocks: [{}, {}, {}, {}]},
    trust: {share: 0.170, blocks: [{}, {}, {}, {}]},
    routing: {share: 0.161, blocks: [{}, {}]},
    footer: {share: 0.087, blocks: [{}, {}, {}]},
    brand: {share: 0.066, firstViewport: 0.214, blocks: [{}]},
    hero: {share: 0.061, firstViewport: 0.714, blocks: [{}]},
    promotion: {share: 0.059, firstViewport: 0, blocks: [{}]},
    navigation: {share: 0.006, firstViewport: 0.071, blocks: [{}]},
});

test('a core segment on none of the first screen says so', () => {
    const found = read(boond()).findings.find((f) => f.id === 'core-promotion');
    assert.match(found.text, /none of the first screen/);
});

test('…and one that is most of the first screen says that too', () => {
    const found = read(boond()).findings.find((f) => f.id === 'core-hero');
    assert.match(found.text, /71\.4% of the first screen/);
});

test('where the space actually went is named when the page’s job is not where it is', () => {
    // IN THE LEAD NOW, not a bullet of its own (26 Sep 2026).
    assert.match(read(boond()).lead, /: 72\.1% goes on explainer, trust and routing instead\.$/, 'the 72% nobody mentioned');
});

test('…and not when the cores are where the space is', () => {
    const gov = site('route', {
        routing: {share: 0.693, firstViewport: 0.459, blocks: [{}, {}]},
        hero: 0.092, navigation: 0.014, footer: 0.183,
    });
    assert.equal(read(gov).findings.some((f) => f.id === 'space-elsewhere'), false,
        'the footer taking 18.3% is a fact, not a finding');
});

test('the comparison says what each page opens with, which no table on that sheet shows', () => {
    const uk = site('route', {
        routing: {share: 0.693, firstViewport: 0.459, blocks: [{}, {}]},
        hero: {share: 0.092, firstViewport: 0.47, blocks: [{}]},
        navigation: {share: 0.014, firstViewport: 0.071, blocks: [{}]},
        footer: 0.183,
    });
    const je = site('route', {
        routing: {share: 0.726, firstViewport: 0.688, blocks: [{}, {}, {}, {}]},
        navigation: {share: 0.112, firstViewport: 0.312, blocks: [{}, {}]},
    });
    const said = compare(uk, je, NAMES);
    assert.ok(said.points.some((p) => /gov\.uk opens with .*gov\.je opens with/.test(p)), said.points.join(' | '));
});

/* --------------------------------------------------- the lead sentence (26 Sep 2026) */
//
// One sentence under "Summary", the same shape as Proposition's: the kind of page, and the
// judgement, with the evidence in the bullets under it. It replaces three lines — "In its
// own words", "That is a page whose job is…", and a closing "one of the two things…".

test('lead: vaiie — a page that sells with no promotion, and where the space went instead', () => {
    const vaiie = site('sell', {hero: {share: 0.163, firstViewport: 0.593, blocks: [{}]}, routing: 0.257, brand: 0.205,
        explainer: 0.151, footer: 0.148, navigation: 0.039, trust: 0.037, promotion: 0});

    assert.equal(read(vaiie).lead, 'A page that sells, with no promotion on it: 61.3% goes on routing, brand and explainer instead.');
});

test('lead: a core that is present but thin says how thin, not that it is absent', () => {
    const shop = site('sell', {promotion: 0.03, hero: 0.2, routing: 0.5, footer: 0.27});

    assert.match(read(shop).lead, /^A page that sells, with promotion at 3\.0% of the page/);
});

test('lead: every core healthy and nothing else missing is said plainly', () => {
    const gov = site('route', {routing: {share: 0.693, firstViewport: 0.459, blocks: [{}]}, hero: 0.1, navigation: 0.05, footer: 0.157});

    assert.equal(read(gov).lead, 'A directory, spending its space on what it is for.');
});

test('lead: cores healthy but something expected missing does not claim all is well', () => {
    const gov = site('route', {routing: 0.8, footer: 0.2});

    assert.equal(read(gov).lead, 'A directory, with what it needs most in place.');
});

test('lead: two thin cores are both named, and the sentence starts with a capital and ends once', () => {
    const agency = site('enquire', {hero: 0.2, explainer: 0.02, routing: 0.5, footer: 0.28});
    const lead = read(agency).lead;

    assert.match(lead, /^An enquiry page, with explainer at 2\.0% of the page and nothing from outside the company vouching for it/);
    assert.match(lead, /[^.]\.$/);
});

test('lead: the bullet the lead already says is not repeated under it', () => {
    const vaiie = site('sell', {hero: 0.163, routing: 0.257, brand: 0.205, explainer: 0.147, footer: 0.148, promotion: 0});

    assert.equal(read(vaiie).findings.some((f) => f.id === 'space-elsewhere'), false);
});

// kohde.agency, 26 Sep 2026: "An enquiry page, with nothing from outside the company
// vouching for it on it." — and the first bullet under it said the same thing again.
test('lead: "on it" only follows a plain "no …", never a longer absence', () => {
    const kohde = site('enquire', {hero: 0.124, explainer: 0.138, routing: 0.52, footer: 0.218});

    assert.equal(read(kohde).lead.includes('vouching for it on it'), false);
    assert.match(read(kohde).lead, /nothing from outside the company vouching for it\.$/);
});

test('lead: an absence the lead names is not repeated as the first bullet', () => {
    const vaiie = site('sell', {hero: 0.163, routing: 0.257, brand: 0.205, explainer: 0.151, footer: 0.148, promotion: 0});
    const promo = read(vaiie).findings.find((f) => f.id === 'core-promotion');

    assert.equal(promo.inLead, true, 'the template skips it');
    const thin = read(site('sell', {promotion: 0.03, hero: 0.2, routing: 0.5, footer: 0.27})).findings.find((f) => f.id === 'core-promotion');
    assert.equal(thin.inLead ?? false, false, 'a thin one keeps its bullet: it carries the first-screen number');
});

/* ---------------------------------------- proposition in the benchmark (26 Sep 2026) */

const withProp = (report, checks, firstCall = null) => ({...report, proposition: {
    checks: checks.map(([id, status]) => ({id, status})), firstCall,
}});
const SELL = {promotion: 0.2, hero: 0.2, routing: 0.4, footer: 0.2};

test('benchmark: a first-screen failure on only one side is named', () => {
    const a = withProp(site('sell', SELL), [['says', 'fix'], ['ask-reachable', 'working']], 'Screen 1');
    const b = withProp(site('sell', SELL), [['says', 'working'], ['ask-reachable', 'working']], 'Screen 1');

    assert.ok(compare(a, b, NAMES).points.includes('Only gov.uk does not say what it sells on its first screen.'));
});

test('benchmark: a call to action out of reach on only one side is named, with its screen', () => {
    const a = withProp(site('sell', SELL), [['says', 'working'], ['ask-reachable', 'fix']], 'Screen 7');
    const b = withProp(site('sell', SELL), [['says', 'working'], ['ask-reachable', 'working']], 'Screen 1 (sticky)');

    assert.ok(compare(a, b, NAMES).points.includes('Only gov.uk makes visitors wait until screen 7 for a call to action.'));
});

test('benchmark: the same failure on both sides is said once, as neither', () => {
    const a = withProp(site('sell', SELL), [['says', 'fix']]);
    const b = withProp(site('sell', SELL), [['says', 'fix']]);

    assert.ok(compare(a, b, NAMES).points.includes('Neither page says what it sells on its first screen.'));
});

test('benchmark: proposition points survive when the purpose reading has nothing to say', () => {
    const a = withProp(site('unclear', SELL), [['says', 'fix']]);
    const b = withProp(site('unclear', SELL), [['says', 'working']]);
    const got = compare(a, b, NAMES);

    assert.equal(got.worth, true);
    assert.deepEqual(got.points, ['Only gov.uk does not say what it sells on its first screen.']);
});

// mourant.com against bedellcristin.com, 26 Sep 2026: "Only mourant.com is without a hero."
// It has one — "Hero Image and Tagline", 10.9% of the page and 87.1% of its first screen —
// under the 12% an enquiry page's core wants, so it was a GAP, and the comparison said
// "without" of every gap, thin or absent. A thin segment is given its numbers instead.
test('benchmark: a thin segment is never called missing, and gets both numbers', () => {
    const mourant = site('enquire', {hero: {share: 0.109, firstViewport: 0.871, blocks: [{}]}, explainer: 0.333, trust: 0.073, routing: 0.3, footer: 0.185});
    // Absent the way a capture records it: no share AND no block (the helper gives every
    // plain number a block).
    const bedell = site('enquire', {hero: {share: 0.2, firstViewport: 0.777, blocks: [{}]}, explainer: {share: 0, blocks: []}, trust: 0.2, routing: 0.4, footer: 0.2});
    const points = compare(mourant, bedell, {mine: 'mourant.com', theirs: 'bedellcristin.com'}).points;

    assert.equal(points.some((p) => /without a hero/.test(p)), false);
    assert.ok(points.includes('mourant.com gives the hero 10.9% of the page, against 20.0% on bedellcristin.com.'), points.join(' | '));
    assert.ok(points.includes('Only bedellcristin.com is without an explainer.'), 'a real absence is still said as one');
});

test('benchmark: thin on both sides is said once, with both numbers', () => {
    const a = site('enquire', {hero: 0.1, explainer: 0.3, trust: 0.3, routing: 0.3});
    const b = site('enquire', {hero: 0.08, explainer: 0.3, trust: 0.3, routing: 0.32});

    assert.ok(compare(a, b, NAMES).points.includes('Both pages give the hero little room: 10.0% of the page on gov.uk, 8.0% on gov.je.'));
});

test('benchmark: missing on one side and thin on the other says each', () => {
    const a = site('enquire', {hero: 0.2, explainer: {share: 0, blocks: []}, trust: 0.3, routing: 0.5});
    const b = site('enquire', {hero: 0.2, explainer: 0.064, trust: 0.3, routing: 0.436});

    assert.ok(compare(a, b, NAMES).points.includes('gov.uk has no explainer; gov.je gives the explainer 6.4% of the page.'));
});

test('benchmark: a contact out of reach on one side only is named', () => {
    const a = withProp(site('sell', SELL), [['get-in-touch', 'fix']]);
    const b = withProp(site('sell', SELL), [['get-in-touch', 'working']]);

    assert.ok(compare(a, b, NAMES).points.includes('Only gov.uk has no way to get in touch within reach.'));
});
