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
import {MAX_IMAGE_PAGES, PAGE, reportData, sliceAnnotated, stubTemplate, withColourGroups} from '../lib/pdf.mjs';
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
