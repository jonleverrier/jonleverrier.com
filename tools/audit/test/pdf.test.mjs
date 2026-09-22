/**
 * PDF
 *
 *   node --test tools/audit/test/pdf.test.mjs
 *
 * The pagination arithmetic and the seam between measurement and presentation. Rendering
 * itself needs Chromium and is exercised by running the CLI against a real audit
 * directory; what is here is everything that decides WHAT a template is handed.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {brandScore, DEFERRAL_TARGET, DUPLICATE_PENALTY, MAX_IMAGE_PAGES, MEDIAN_PAGE_MB, PAGE,
    reportData, sliceAnnotated, stubTemplate, technicalScore, UNSURE, withColourGroups,
    withEmptyCategories} from '../lib/pdf.mjs';
import {CATEGORY_ORDER} from '../lib/surface.mjs';
import {SAME_COLOUR_DE} from '../lib/styles.mjs';

const leaf = (y, h, category, coverage = 0.4) => ({
    x: 0, y, w: 1440, h, depth: 1, children: [], coverage,
    label: {category, what: 'x', cols: 1, confidence: 0.9},
});

/** An audit directory, as analyse.mjs leaves one. */
const audit = (over = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
    const children = over.children ?? [leaf(0, 1100, 'promotion'), leaf(1100, 900, 'hero')];
    const height = children.reduce((a, c) => a + c.h, 0);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        url: 'https://a.com', capturedUrl: 'https://a.com/', capturedAt: '2026-09-20T10:00:00.000Z',
        viewport: {width: 1440, height: 900}, image: {width: 1440, height},
        ...over.meta,
    }));
    writeFileSync(join(dir, 'blocks.json'), JSON.stringify({
        notes: over.notes ?? {metaRead: true, conditions: {}},
        tree: {x: 0, y: 0, w: 1440, h: height, depth: 0, children},
    }));

    return dir;
};

/* ------------------------------------------------------- what a template is handed */

test('the data carries the percentages, the blocks and where they sit above the fold', () => {
    const data = reportData(audit());
    assert.equal(data.url, 'https://a.com');
    assert.equal(data.blocks, 2);
    assert.equal(data.categories[0].category, 'promotion', 'biggest first, as the table prints it');
    assert.equal(data.categories[0].firstViewport, 1, 'and it is the whole first viewport');
    assert.equal(data.categories[1].firstViewport, null, 'and the other is not in it at all');
});

/**
 * THE HONESTY LAYER IS NOT OPTIONAL. A report that drops these is not this tool's report,
 * so they reach the template verbatim rather than as a flag it may choose to act on.
 */
test('every caveat reaches the template with its effect and its own wording', () => {
    const data = reportData(audit({
        notes: {metaRead: true, conditions: {
            webglBlind: {effect: 'unmeasured', message: 'it asked for webgl and never drew', facts: {}},
        }},
    }));
    assert.deepEqual(data.caveats, [{effect: 'unmeasured', message: 'it asked for webgl and never drew'}]);
    assert.deepEqual(data.noteCodes, ['webglBlind']);
});

/** A capture taken before a signal existed has none of it, and must not invent any. */
test('speed, weight and styles are null when the capture predates them', () => {
    const data = reportData(audit());
    assert.equal(data.speed, null);
    assert.equal(data.weight, null);
    assert.equal(data.weightSummary, null);
    assert.equal(data.styles, null);
});

test('a PSI that failed is not reported as a speed', () => {
    const data = reportData(audit({meta: {psi: {error: 'PageSpeed answered 429'}}}));
    assert.equal(data.speed, null, 'an error is an absence, not a score of nought');
});

test('a byte census that could not attach is not reported as a weightless page', () => {
    const data = reportData(audit({meta: {bytes: {measured: false, why: 'target closed'}}}));
    assert.equal(data.weight, null);
});

/* ------------------------------------------------------------------- the pagination */

const tall = async (height) => {
    const dir = mkdtempSync(join(tmpdir(), 'png-'));
    const path = join(dir, 'debug.png');
    await sharp({create: {width: 1440, height, channels: 3, background: {r: 200, g: 200, b: 200}}})
        .png().toFile(path);

    return path;
};

/**
 * CSS CANNOT BREAK AN IMAGE ACROSS PAGES — it either overflows and is cut or shrinks to
 * illegibility — so a homepage screenshot has to be cut into page-height slices before it
 * ever reaches the document. jersey.com is 16,368px and visionarygrid.studio 24,746.
 */
test('a page taller than one sheet is cut into one slice per sheet', async () => {
    const box = PAGE.height - PAGE.margin * 2;
    const width = PAGE.width - PAGE.margin * 2;
    // Three sheets' worth, at the scale the slicer will use.
    const got = await sliceAnnotated(await tall(Math.round((box * 3 * 1440) / width)));
    assert.equal(got.slices.length, 3);
    assert.equal(got.pages, 3);
    assert.equal(got.truncated, false);
});

test('a short page is one slice and is not padded to a full sheet', async () => {
    const got = await sliceAnnotated(await tall(400));
    assert.equal(got.slices.length, 1);
    assert.ok(got.slices[0].height < PAGE.height - PAGE.margin * 2);
});

test('the slices are data URIs, so there is no second file for the PDF to lose', async () => {
    const got = await sliceAnnotated(await tall(400));
    assert.match(got.slices[0].uri, /^data:image\/jpeg;base64,/);
});

/**
 * visionarygrid.studio is twelve sheets of screenshot. Whether that is thorough or
 * unreadable is a judgement about the report, so there is a ceiling and it declares when
 * it bites rather than quietly dropping the bottom of somebody's page.
 */
test('past the ceiling it stops, and says that it stopped', async () => {
    const box = PAGE.height - PAGE.margin * 2;
    const width = PAGE.width - PAGE.margin * 2;
    const got = await sliceAnnotated(await tall(Math.round((box * 5 * 1440) / width)), 2);
    assert.equal(got.slices.length, 2);
    assert.equal(got.pages, 5);
    assert.equal(got.truncated, true, 'a reader must be able to tell the page was longer');
});

test('the ceiling is a number, not a silent default', () => {
    assert.equal(typeof MAX_IMAGE_PAGES, 'number');
    assert.ok(MAX_IMAGE_PAGES > 0);
});

/* ---------------------------------------------------------------------- the template */

test('the stub prints the caveats, whatever else it does', () => {
    const data = reportData(audit({
        notes: {metaRead: true, conditions: {
            blankRegion: {effect: 'unmeasured', message: 'nothing painted in 1440x2707', facts: {}},
        }},
    }));
    const html = stubTemplate(data, {slices: [], pages: 0, truncated: false});
    assert.match(html, /nothing painted in 1440x2707/);
    assert.match(html, /What this does not cover/);
});

/** A page's own text reaches this document, so it goes out escaped. */
test('page text cannot close a tag on its way into the document', () => {
    const data = reportData(audit({meta: {url: 'https://a.com/"><script>alert(1)</script>'}}));
    const html = stubTemplate(data, {slices: [], pages: 0, truncated: false});
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
});

test('one image page becomes one printed section', () => {
    const data = reportData(audit());
    const html = stubTemplate(data, {slices: [{uri: 'data:image/jpeg;base64,AA', height: 10}], pages: 1, truncated: false});
    assert.equal((html.match(/class="shot"/g) ?? []).length, 1);
});

/* ------------------------------------------------- the grouping, derived at report time */

/**
 * Which colours are the same colour is a judgement at a threshold, not a measurement, so
 * it is derived here rather than frozen into meta.json when the page was photographed.
 * Moving the threshold must not mean re-capturing a site whose colours have not moved.
 */
test('the colour grouping is added to the measured palette', () => {
    const styles = {measured: true, colours: {total: 2, values: 2, palette: [
        {colour: 'rgb(64, 64, 64)', area: 900},
        {colour: 'rgb(68, 68, 68)', area: 10},
    ]}, fonts: {declared: 0, loaded: 0, families: [], rendered: [], faces: []}, fontSizes: []};
    const got = withColourGroups(styles);
    assert.deepEqual(got.colours.sameColour, [['rgb(64, 64, 64)', 'rgb(68, 68, 68)']]);
    assert.equal(got.colours.deltaE, SAME_COLOUR_DE);
    assert.deepEqual(got.colours.palette, styles.colours.palette, 'the measurement is untouched');
});

/**
 * kohde.agency. White and rgb(240,240,245) are dE 5.69 apart and visibly different; they
 * were reported as the same colour because a chain joined them through rgb(250,250,252).
 * A reader saw it immediately.
 */
test('a chain does not make a group', () => {
    const styles = {measured: true, colours: {total: 3, values: 3, palette: [
        {colour: 'rgb(250, 250, 252)', area: 900},
        {colour: 'rgb(255, 255, 255)', area: 500},
        {colour: 'rgb(240, 240, 245)', area: 100},
    ]}, fonts: {declared: 0, loaded: 0, families: [], rendered: [], faces: []}, fontSizes: []};
    const groups = withColourGroups(styles).colours.sameColour;
    assert.equal(groups.length, 1, 'only the pair that really is one colour');
    assert.equal(groups[0].length, 2);
    assert.ok(!groups[0].includes('rgb(240, 240, 245)'));
});

/* ------------------------------------------------- the technical score, ours not Google's */

const MB = 1048576;
const weight = (totalMb, deferred = 0) => ({
    measured: true,
    afterScroll: {bytes: Math.round(totalMb * MB), requests: 10},
    atLoad: {bytes: Math.round(totalMb * MB * (1 - deferred)), requests: 8},
});
const TALL = 9000;

/**
 * THE CURVE IS THE POINT. A linear score makes 4.6MB and 9.2MB both simply "bad" and stops
 * telling pages apart where it matters most; on a log curve doubling always costs the same,
 * so the difference between twice the median and four times it is still 5 points.
 */
test('doubling a page\'s weight always costs the same, wherever it started', () => {
    const at = (mb) => technicalScore(weight(mb), TALL).weightScore;
    assert.equal(at(MEDIAN_PAGE_MB), 10, 'the median scores full marks');
    assert.equal(at(MEDIAN_PAGE_MB * 2), 5);
    assert.equal(at(MEDIAN_PAGE_MB * 4), 0);
    // And the step between each doubling is the same 5 points, not a shrinking tail.
    assert.equal(at(MEDIAN_PAGE_MB) - at(MEDIAN_PAGE_MB * 2), at(MEDIAN_PAGE_MB * 2) - at(MEDIAN_PAGE_MB * 4));
});

test('a page lighter than the median is not scored above ten', () => {
    assert.equal(technicalScore(weight(0.2), TALL).weightScore, 10);
});

test('deferral earns its forty per cent, and full marks at the target', () => {
    const none = technicalScore(weight(MEDIAN_PAGE_MB, 0), TALL);
    const target = technicalScore(weight(MEDIAN_PAGE_MB, DEFERRAL_TARGET), TALL);
    assert.equal(none.deferScore, 0);
    assert.equal(target.deferScore, 10);
    // Same weight, so the whole gap between them is the deferral's share.
    assert.equal(Number((target.score - none.score).toFixed(1)), 4);
});

/**
 * whitepaper.co.uk is why. 0.2MB and nothing deferred, because there is nothing below the
 * fold to defer — the correct behaviour for a short page, scored 6 before this guard.
 */
test('a page with nothing below the fold is not punished for deferring nothing', () => {
    const short = technicalScore(weight(0.2, 0), 1200);
    assert.equal(short.shortPage, true);
    assert.equal(short.deferScore, 10);
    assert.equal(short.score, 10);
});

test('an unmeasured census scores nothing rather than nought', () => {
    assert.equal(technicalScore({measured: false}, TALL), null, 'a score of 0 would be a verdict we did not earn');
    assert.equal(technicalScore(null, TALL), null);
});

test('the report carries the score, and carries null when there was no census', () => {
    assert.equal(reportData(audit()).technical, null);
    const scored = reportData(audit({meta: {bytes: weight(4.3, 0)}}));
    assert.ok(scored.technical.score > 0 && scored.technical.score < 10);
});

/* ------------------------------------------------ the brand score: duplicates, not taste */

const styled = (palette, sameColour) => ({
    colours: {total: palette.length, values: palette.length, deltaE: 2.3, palette, sameColour},
});
const colours = (...areas) => areas.map((area, i) => ({colour: `rgb(${i}, 0, 0)`, area}));

test('a page with no two colours a person could confuse scores ten', () => {
    assert.equal(brandScore(styled(colours(4000, 3000, 2000), [])).score, 10);
});

test('each group of colours nobody can tell apart costs its penalty', () => {
    const one = styled(colours(4000, 3000, 2000), [['rgb(0, 0, 0)', 'rgb(1, 0, 0)']]);
    assert.equal(brandScore(one).score, 10 - DUPLICATE_PENALTY);
    assert.equal(brandScore(one).groups, 1);
    assert.equal(brandScore(one).colours, 2, 'the colours involved, for the row beside the score');
});

/**
 * NOT A JUDGEMENT ON THE PALETTE'S SIZE. Eleven colours is a choice and six is a choice, so
 * a wide palette with nothing duplicated takes full marks. This is the line between a
 * consistency score and a taste one, and it is the whole reason area was abandoned.
 */
test('a big palette is not punished for being big', () => {
    assert.equal(brandScore(styled(colours(...Array(14).fill(1000)), [])).score, 10);
});

/**
 * whitepaper.co.uk is why area was rejected. Its brand red covers 0.54% of the page because
 * a button is small, and the area-based version marked the most deliberate colour on the
 * page as a leftover. A tiny colour is not a fault.
 */
test('a deliberate accent covering almost nothing costs nothing', () => {
    assert.equal(brandScore(styled(colours(9000, 5000, 60), [])).score, 10);
});

test('the score has a floor, so a chaotic page is not scored below nothing', () => {
    const many = Array.from({length: 9}, (_, i) => [`rgb(${i}, 0, 0)`, `rgb(${i}, 0, 1)`]);
    assert.equal(brandScore(styled(colours(1000, 1000), many)).score, 0);
});

test('no grouping means no score, rather than a score of ten', () => {
    assert.equal(brandScore(null), null);
    assert.equal(brandScore({colours: {palette: colours(10)}}), null, 'ungrouped styles cannot be scored');
});

/* ----------------------------------------------------- every category, including nought */

/**
 * AN ABSENT ROW AND A NOUGHT ROW SAY DIFFERENT THINGS. Absent reads as a category nobody
 * checked; 0.0% reads as a page that spends nothing on it, which is often the finding —
 * atkinsonsca.co.uk gives no space at all to `trust`, and for an accountancy firm that is
 * worth a reader seeing.
 */
test('a category the page spends nothing on is printed at nought, not dropped', () => {
    const rows = withEmptyCategories([{category: 'hero', area: 10, share: 1, coverage: 0.2, firstViewport: 1}]);
    const trust = rows.find((r) => r.category === 'trust');
    assert.ok(trust, 'trust was never on the page, and that is the point');
    assert.equal(trust.share, 0);
    assert.equal(trust.coverage, null, 'nothing was measured, so there is no ink figure to give');
    assert.equal(trust.firstViewport, null);
});

test('every category the table can print gets a row', () => {
    const rows = withEmptyCategories([{category: 'hero', area: 10, share: 1}]);
    for (const c of CATEGORY_ORDER) {
        if (c === 'unclassified') continue;
        assert.ok(rows.some((r) => r.category === c), `${c} has no row`);
    }
});

/**
 * `unclassified` is not a category, it is the model declining to guess. A nought row for it
 * would tell a reader nothing about their homepage, and put a refusal in a table of findings.
 */
test('unclassified is not invented, and stays last when it is real', () => {
    assert.ok(!withEmptyCategories([{category: 'hero', share: 1}]).some((r) => r.category === 'unclassified'));
    const withIt = withEmptyCategories([
        {category: 'hero', share: 0.8},
        {category: 'unclassified', share: 0.2},
    ]);
    assert.equal(withIt[withIt.length - 1].category, 'unclassified', 'a refusal is never the page\'s smallest feature');
});

test('the measured rows keep their order and their numbers', () => {
    const rows = withEmptyCategories([
        {category: 'routing', share: 0.6},
        {category: 'hero', share: 0.4},
    ]);
    assert.deepEqual(rows.slice(0, 2).map((r) => r.category), ['routing', 'hero']);
    assert.equal(rows[0].share, 0.6);
});

/* ------------------------------------------------ the blocks behind each category's share */

/**
 * "Explainer 57.8%" says nothing a reader can act on; seven named sections does. The number
 * beside each is its index in leaves() order, which is what lib/debug.mjs draws on the
 * annotated screenshot — read 4 in the table, find 4 on the image. If the two ever stop
 * agreeing the table points at the wrong section, which is worse than pointing at nothing.
 */
test('each category carries the blocks it is made of, numbered as the screenshot numbers them', () => {
    const data = reportData(audit({children: [
        leaf(0, 100, 'navigation'), leaf(100, 900, 'hero'), leaf(1000, 500, 'hero'),
    ]}));
    const hero = data.categories.find((c) => c.category === 'hero');
    assert.equal(hero.blocks.length, 2);
    assert.deepEqual(hero.blocks.map((b) => b.n), [1, 2], 'the indices are leaves() order, from zero');
    assert.equal(hero.blocks[0].what, 'X', 'the description the model gave, title cased for print');
    assert.equal(data.categories.find((c) => c.category === 'navigation').blocks[0].n, 0);
});

test('a category the page spends nothing on has no blocks rather than no field', () => {
    const trust = reportData(audit()).categories.find((c) => c.category === 'trust');
    assert.deepEqual(trust.blocks, [], 'an absent list is a shape change a template would trip on');
});

/**
 * kohde.agency block 4: a case study card the model called `explainer`, scoring itself 0.6 —
 * the lowest on the page, and the only label on it that was wrong. The confidence was
 * measured and discarded, so finding the mistake meant cropping the screenshot by hand.
 */
test('a block the model was unsure about is marked as such', () => {
    const unsure = (c) => ({x: 0, y: 0, w: 1440, h: 900, depth: 1, children: [], coverage: 0.4,
        label: {category: 'explainer', what: 'x', cols: 1, confidence: c}});
    const data = reportData(audit({children: [unsure(0.6), unsure(0.95)]}));
    const blocks = data.categories.find((b) => b.category === 'explainer').blocks;
    assert.equal(blocks[0].unsure, true, `0.6 is below ${UNSURE}`);
    assert.equal(blocks[1].unsure, false);
    assert.equal(blocks[0].confidence, 0.6, 'the number survives, not just the verdict');
});

/** A block with no label at all is not silently confident. */
test('a block with no confidence recorded is not marked as sure', () => {
    const bare = {x: 0, y: 0, w: 1440, h: 900, depth: 1, children: [], coverage: 0.4};
    const blocks = reportData(audit({children: [bare]})).categories
        .find((b) => b.category === 'unclassified').blocks;
    assert.equal(blocks[0].confidence, null);
    assert.equal(blocks[0].unsure, false, 'unmeasured is not the same as doubted');
});
