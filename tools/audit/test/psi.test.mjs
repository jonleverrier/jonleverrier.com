/**
 * PSI
 *
 *   node --test tools/audit/test/psi.test.mjs
 *
 * No network. The two fixtures are REAL responses — natwest.com, a bank, and kohde.agency,
 * a small agency with too little traffic for Google to report on at all. That pair is the
 * evidence for taking lab data and only lab data: the big site has CrUX and the small one
 * has none, while LAB WAS COMPLETE FOR BOTH. One report, one shape, a number every time.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    ENDPOINT, STRATEGY, fetchPsi, labMetrics, parsePsi, psiKey, worthRetrying,
} from '../lib/psi.mjs';

const fixture = (name) => JSON.parse(readFileSync(`tools/audit/fixtures/psi-${name}.fixture.json`, 'utf8'));
const natwest = fixture('natwest');
const kohde = fixture('kohde');

/* ------------------------------------------------------------------ the lab run */

test('the seven lab metrics come back from a real response', () => {
    const lab = labMetrics(natwest.lighthouseResult.audits);
    assert.deepEqual(lab, {
        fcpMs: 596, lcpMs: 2262, tbtMs: 97, cls: 0.05,
        speedIndexMs: 1891, ttiMs: 2766, serverResponseMs: 92,
    });
});

/** kohde.agency has no CrUX at all, and its lab run is still complete. That is the point. */
test('a site too small for CrUX still has every lab metric', () => {
    const lab = labMetrics(kohde.lighthouseResult.audits);
    for (const [k, v] of Object.entries(lab)) {
        assert.equal(typeof v, 'number', `${k} is missing on a small site`);
    }
    assert.equal(lab.tbtMs, 648, 'and it is the number that tells the story');
});

/**
 * CLS is a unitless score where 0.1 separates good from needs-work. Rounding it to an
 * integer would report every page on the web as a flat 0 — and it very nearly did. The
 * throwaway script used to survey this response printed `raw 0` for natwest.com because it
 * formatted with toFixed(0), and that 0 was copied straight into the assertion above. The
 * real value is 0.05. A rounding decision made in a scratch script had already travelled
 * into a test claiming to describe the page.
 */
test('layout shift keeps its decimals', () => {
    const lab = labMetrics({'cumulative-layout-shift': {numericValue: 0.2467}});
    assert.equal(lab.cls, 0.247);
});

test('a metric that is absent is null, never zero', () => {
    assert.equal(labMetrics({}).lcpMs, null);
    assert.equal(labMetrics({'largest-contentful-paint': {}}).lcpMs, null);
});

/* ---------------------------------------------------------------------- parsing */

test('a real response reduces to the fields a report needs', () => {
    const got = parsePsi(natwest);
    assert.equal(got.score, 84);
    assert.equal(got.strategy, 'desktop');
    assert.equal(got.finalUrl, 'https://www.natwest.com/');
    assert.equal(got.lighthouseVersion, '13.4.1');
    assert.equal(got.lab.lcpMs, 2262);
});

/**
 * CrUX is real visitors and it is the better number, and it is deliberately not collected:
 * it exists for natwest and not for kohde, and kohde is what almost every prospect looks
 * like. A section that appears for one site in twenty is two reports, not one.
 */
test('field data is not carried, even when the response has it', () => {
    assert.ok(natwest.loadingExperience?.metrics, 'the fixture really does have CrUX');
    assert.equal('field' in parsePsi(natwest), false);
});

/**
 * PSI follows redirects as readily as our own capture does, and dept.agency answers 301 to
 * dept.global. A speed score attributed to the wrong domain is wrong in a way no rounding
 * can fix, so the URL it actually measured is kept.
 */
test('the URL PSI ended on is kept beside the one that was asked for', () => {
    const got = parsePsi({...natwest, id: 'https://dept.agency',
        lighthouseResult: {...natwest.lighthouseResult, finalUrl: 'https://www.dept.global/'}});
    assert.equal(got.requestedUrl, 'https://dept.agency');
    assert.equal(got.finalUrl, 'https://www.dept.global/');
});

/** Zero is a real score. A page whose score we could not read must not be given the worst one. */
test('an unreadable score is an error, not a nought', () => {
    const noScore = {lighthouseResult: {...natwest.lighthouseResult, categories: {}}};
    assert.match(parsePsi(noScore).error, /no performance score/);
    assert.match(parsePsi({}).error, /no lighthouseResult/);

    const zero = {...natwest,
        lighthouseResult: {...natwest.lighthouseResult, categories: {performance: {score: 0}}}};
    assert.equal(parsePsi(zero).score, 0, 'and a genuine zero survives');
});

/* --------------------------------------------------------------------- fetching */

const ok = (payload) => ({ok: true, status: 200, json: async () => payload});
const bad = (status, body = '') => ({ok: false, status, text: async () => body});

test('a successful fetch asks for desktop, with the key and the performance category', async () => {
    let asked = null;
    await fetchPsi('https://a.com', {key: 'k', fetch: async (u) => { asked = u; return ok(natwest); }});
    const q = new URL(asked);
    assert.equal(q.origin + q.pathname, ENDPOINT);
    assert.equal(q.searchParams.get('strategy'), STRATEGY);
    assert.equal(q.searchParams.get('strategy'), 'desktop', 'mobile would describe a different page');
    assert.equal(q.searchParams.get('category'), 'performance');
    assert.equal(q.searchParams.get('url'), 'https://a.com');
});

test('a 429 is asked again and can succeed', async () => {
    let calls = 0;
    const got = await fetchPsi('https://a.com', {
        key: 'k', sleep: async () => {},
        fetch: async () => (++calls === 1 ? bad(429, 'quota') : ok(natwest)),
    });
    assert.equal(calls, 2);
    assert.equal(got.score, 84);
});

/** A 400 will say the same thing next time, and a retry only costs the prospect a wait. */
test('a 400 is accepted first time', async () => {
    let calls = 0;
    const got = await fetchPsi('https://a.com', {
        key: 'k', sleep: async () => {}, fetch: async () => { calls++; return bad(400, 'bad key'); },
    });
    assert.equal(calls, 1);
    assert.match(got.error, /400/);
});

/**
 * Google's own explanation of a failure is the difference between a five-minute fix and an
 * afternoon — a disabled API and an exhausted quota look identical without it.
 */
test('the failure carries what Google said about it', async () => {
    const got = await fetchPsi('https://a.com', {
        key: 'k', sleep: async () => {}, fetch: async () => bad(403, 'PageSpeed Insights API has not been used'),
    });
    assert.match(got.error, /has not been used/);
});

test('a fetch that throws is an error, never a throw', async () => {
    const got = await fetchPsi('https://a.com', {
        key: 'k', sleep: async () => {}, fetch: async () => { throw new Error('timed out'); },
    });
    assert.match(got.error, /timed out/);
});

/**
 * Without the model's key there is no measurement and the run should stop. Without this one
 * there is simply no speed section, and an audit that refuses because a SUPPORTING number
 * is unavailable has its priorities backwards.
 */
test('no key is a reason, not an exception', async () => {
    const got = await fetchPsi('https://a.com', {key: null, envPath: 'tools/audit/test/nothing-here.env'});
    assert.match(got.error, /GOOGLE_CLOUD_KEY/);
    assert.equal(psiKey('tools/audit/test/nothing-here.env'), null);
});

test('only the answers that could change are asked again', () => {
    assert.equal(worthRetrying(429), true);
    assert.equal(worthRetrying(500), true);
    assert.equal(worthRetrying(503), true);
    assert.equal(worthRetrying(null), true);
    assert.equal(worthRetrying(400), false);
    assert.equal(worthRetrying(403), false);
    assert.equal(worthRetrying(404), false);
});
