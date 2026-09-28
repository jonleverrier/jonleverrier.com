/**
 * CHECKS
 *
 *   node --test tools/audit/test/checks.test.mjs
 *
 * The traffic lights under Speed, Technical and Consistency. Numbers are real ones from the
 * corpus, named by site, so a failing threshold points at the page it was drawn for.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bytes, checks, consistencyChecks, speedChecks, technicalChecks} from '../lib/checks.mjs';
import {technicalScore} from '../lib/pdf.mjs';

const MB = 1048576;
const status = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.status]));
const row = (rows, id) => rows.find((r) => r.id === id);

/* ------------------------------------------------------------------ speed */

/** bedellcristin.com: 47, with a 5.6s LCP and a layout shift over 1. */
const bedell = {score: 47, lab: {fcpMs: 664, lcpMs: 5635, tbtMs: 43, cls: 1.128, speedIndexMs: 2032}};

test("speed is judged on Google's lines, and says whose they are", () => {
    const rows = speedChecks(bedell, null);
    assert.deepEqual(status(rows), {pagespeed: 'poor', lcpMs: 'poor', tbtMs: 'good', cls: 'poor'});
    assert.match(row(rows, 'lcpMs').found, /Google: under 2,500ms/);
    assert.equal(row(rows, 'tbtMs').fix, null, 'a green row suggests nothing');
});

test('the three lights sit exactly on the thresholds', () => {
    const at = (lab) => status(speedChecks({score: 90, lab: {fcpMs: 0, speedIndexMs: 0, ...lab}}, null));
    assert.deepEqual(at({lcpMs: 2500, tbtMs: 200, cls: 0.1}), {pagespeed: 'good', lcpMs: 'good', tbtMs: 'good', cls: 'good'});
    assert.deepEqual(at({lcpMs: 4000, tbtMs: 600, cls: 0.25}), {pagespeed: 'good', lcpMs: 'work', tbtMs: 'work', cls: 'work'});
    assert.deepEqual(at({lcpMs: 4001, tbtMs: 601, cls: 0.251}), {pagespeed: 'good', lcpMs: 'poor', tbtMs: 'poor', cls: 'poor'});
    assert.equal(status(speedChecks({score: 49, lab: {lcpMs: 1}}, null)).pagespeed, 'poor');
    assert.equal(status(speedChecks({score: 50, lab: {lcpMs: 1}}, null)).pagespeed, 'work');
});

/**
 * furious-squad.com: 92 live, with every row green — its LCP of 1,781ms passes Google's line
 * and still scores 0.7 on the desktop curve. The suggestion has to say that, not "see below".
 */
test('a score that loses points on a passing metric names the metric', () => {
    const lab = {fcpMs: 530, lcpMs: 1781, tbtMs: 90, cls: 0.008, speedIndexMs: 938};
    const rows = speedChecks({score: 88, lab, lost: {fcpMs: 0, lcpMs: 7.5, tbtMs: 0.6, cls: 0, speedIndexMs: 0.2}}, null);
    assert.equal(row(rows, 'pagespeed').fix, 'Largest Contentful Paint (1,781ms) costs the most: 7.5 of the 12 points missing.');
});

test('and points below when that metric is itself failing', () => {
    const rows = speedChecks({...bedell, lost: {lcpMs: 25, cls: 25, tbtMs: 0}}, null);
    assert.match(row(rows, 'pagespeed').fix, /See below\.$/);
});

test('an older report without the points falls back to the first failing row', () => {
    assert.equal(row(speedChecks(bedell, null), 'pagespeed').fix, 'Start with Largest Contentful Paint, below.');
    const passing = speedChecks({score: 88, lab: {fcpMs: 527, lcpMs: 1841, tbtMs: 166, cls: 0.008, speedIndexMs: 741}}, null);
    assert.match(row(passing, 'pagespeed').fix, /stricter curve/, 'and never invents a cause');
});

test("the blocking-time suggestion counts the page's own scripts", () => {
    const rows = speedChecks({score: 68, lab: {tbtMs: 1232}}, {byType: [{type: 'script', bytes: 706755, requests: 18}]});
    assert.match(row(rows, 'tbtMs').fix, /18 scripts, 690kb/);
});

test('no PageSpeed, no checklist', () => {
    assert.equal(speedChecks(null, null), null);
    assert.equal(speedChecks({error: 'timeout'}, null), null);
});

/* ------------------------------------------------------------------ technical */

const census = (total, atLoad, byType = []) => ({measured: true, afterScroll: {bytes: total, requests: 10}, atLoad: {bytes: atLoad}, byType});

test('weight is judged against the median, which the result names', () => {
    const at = (mb) => {
        const w = census(mb * MB, mb * MB * 0.5, [{type: 'image', bytes: mb * MB * 0.6, requests: 5}]);
        return row(technicalChecks(w, technicalScore(w, 5000)), 'weight');
    };
    assert.equal(at(2.3).status, 'good');
    assert.equal(at(4.6).status, 'work');
    assert.equal(at(4.7).status, 'poor');
    assert.match(at(9.8).found, /above the median page of 2\.3mb/);
    assert.match(at(9.8).fix, /^60% of it is image \(5\.9mb\)\. Serve images/);
    assert.equal(at(2.3).fix, null);
});

/** atkinsonsca.co.uk defers nothing on a 9,151px page; that is the red. */
test('nothing held back on a long page is red, some is amber, 40% is green', () => {
    const at = (share, height = 9151) => {
        const w = census(4 * MB, 4 * MB * (1 - share));
        return row(technicalChecks(w, technicalScore(w, height)), 'deferred');
    };
    assert.equal(at(0).status, 'poor');
    assert.match(at(0).found, /nothing held back/);
    assert.equal(at(0.08).status, 'work');
    assert.equal(at(0.4).status, 'good');
    assert.equal(at(0, 1778).status, 'good', 'a short page has nothing to hold back');
});

/** mourant.com holds back 39.7%, which prints as 40% — beside "aim for 40%". */
test('the deferral light is set on the printed percentage', () => {
    const w = census(1681044, 1013622);
    const r = row(technicalChecks(w, technicalScore(w, 8199)), 'deferred');
    assert.match(r.found, /40% held back/);
    assert.equal(r.status, 'good');
});

/* ------------------------------------------------------------------ consistency */

test('duplicate colours: none green, one or two amber, three red', () => {
    const at = (groups) => consistencyChecks({colours: {palette: [{colour: 'a', area: 1}], sameColour: groups, deltaE: 2.3}}, {score: 10});
    assert.equal(at([])[0].status, 'good');
    assert.match(at([])[0].found, /within dE 2\.3/);
    assert.equal(at([['a', 'b']])[0].status, 'work');
    assert.equal(at([['a', 'b'], ['c', 'd']])[0].status, 'work');
    assert.equal(at([['a', 'b'], ['c', 'd'], ['e', 'f']])[0].status, 'poor');
});

/** mourant.com: rgb(140,25,19) is its biggest colour; the stray twin goes, not the brand. */
test('the suggestion keeps the colour the page uses most', () => {
    const [r] = consistencyChecks({colours: {
        palette: [{colour: 'rgb(139, 26, 20)', area: 10}, {colour: 'rgb(140, 25, 19)', area: 3193379}],
        sameColour: [['rgb(139, 26, 20)', 'rgb(140, 25, 19)']], deltaE: 2.3,
    }}, {score: 8});
    assert.equal(r.fix, 'Use rgb(140, 25, 19) for rgb(139, 26, 20).');
    assert.deepEqual(r.groups, [['rgb(139, 26, 20)', 'rgb(140, 25, 19)']], 'and the template gets the groups to draw');
});

/* ------------------------------------------------------------------ the whole record */

test('checks() reads a report record and nothing else', () => {
    const c = checks({speed: null, weight: null, technical: null, styles: null, brand: null});
    assert.deepEqual(c, {speed: null, technical: null, consistency: null});
});

test('bytes print the way r.bytes() prints them', () => {
    assert.equal(bytes(1.05 * MB), '1.1mb');
    assert.equal(bytes(343 * 1024), '343kb');
});
