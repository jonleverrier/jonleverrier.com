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
