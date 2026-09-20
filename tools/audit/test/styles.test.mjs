/**
 * STYLES
 *
 *   node --test tools/audit/test/styles.test.mjs
 *
 * No browser. COLLECT_STYLES runs in the page and is exercised whole in
 * test/slices.test.mjs; what is here is the arithmetic it feeds — the colour space, the
 * clustering, and the reduction to a record — which is where the decisions are.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    SAME_COLOUR_DE, channels, clusterColours, deltaE, styleRecord, toLab,
} from '../lib/styles.mjs';

/* ------------------------------------------------------------------ colour space */

test('the channels come out of whatever getComputedStyle returned', () => {
    assert.deepEqual(channels('rgb(90, 40, 125)'), [90, 40, 125]);
    assert.deepEqual(channels('rgba(60, 16, 83, 0.6)'), [60, 16, 83], 'alpha is not a channel');
    assert.deepEqual(channels('nonsense'), []);
});

test('black is nought lightness and white is a hundred', () => {
    assert.ok(Math.abs(toLab([0, 0, 0])[0]) < 0.001);
    assert.ok(Math.abs(toLab([255, 255, 255])[0] - 100) < 0.001);
});

/**
 * The reason this is not done in RGB. All three of these are twenty points in one channel
 * from the same mid grey, and to an eye they are 8.3, 15.0 and 11.5 apart — green nearly
 * twice red. A threshold applied to raw RGB distance would be a different threshold for
 * every hue.
 */
test('equal steps in RGB are not equal distances to a person', () => {
    const grey = [128, 128, 128];
    const step = (channel) => {
        const to = [...grey];
        to[channel] += 20;

        return deltaE(toLab(grey), toLab(to));
    };
    const [red, green, blue] = [step(0), step(1), step(2)];
    assert.ok(green > red * 1.5, `green ${green.toFixed(1)} against red ${red.toFixed(1)}`);
    assert.ok(blue > red, `blue ${blue.toFixed(1)} against red ${red.toFixed(1)}`);
});

test('a colour is no distance from itself', () => {
    assert.equal(deltaE(toLab([90, 40, 125]), toLab([90, 40, 125])), 0);
});

/* -------------------------------------------------------------------- clustering */

const c = (colour, area = 1) => ({colour, area});

/** hsbc.co.uk. The one genuine drift found across four sites. */
test('two greys a person would call one grey are one group', () => {
    const groups = clusterColours([c('rgb(64, 64, 64)'), c('rgb(68, 68, 68)')]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
});

/**
 * natwest.com's two purples. They LOOK close as numbers, which is exactly the mistake
 * CIELAB exists to stop: they are comfortably distinct colours and must not be merged.
 */
test('two colours that merely look similar as numbers stay apart', () => {
    const groups = clusterColours([c('rgb(90, 40, 125)'), c('rgb(94, 16, 177)')]);
    assert.equal(groups.length, 2);
});

/** A ramp of near-whites collects into one family of white rather than overlapping pairs. */
test('single-link clustering gathers a run rather than splitting it', () => {
    const groups = clusterColours([
        c('rgb(255, 255, 255)'), c('rgb(250, 250, 252)'), c('rgb(240, 240, 245)'),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
});

test('the largest-area colour leads its group, so the rest read as drift from it', () => {
    const groups = clusterColours([c('rgb(64, 64, 64)', 900), c('rgb(68, 68, 68)', 10)]);
    assert.equal(groups[0][0].colour, 'rgb(64, 64, 64)');
});

test('a tighter limit splits what a looser one joined', () => {
    const pair = [c('rgb(64, 64, 64)'), c('rgb(68, 68, 68)')];
    assert.equal(clusterColours(pair, SAME_COLOUR_DE).length, 1);
    assert.equal(clusterColours(pair, 0.5).length, 2);
});

/* ------------------------------------------------------------------- the record */

const collected = (over = {}) => ({
    colours: [c('rgb(90, 40, 125)', 1000), c('rgba(90, 40, 125, 0.6)', 500), c('rgb(255, 255, 255)', 300)],
    fontSizes: [{size: '16px', count: 40}],
    renderedFamilies: [{family: 'Visuelt', area: 900}],
    faces: [
        {family: 'Visuelt', weight: '400', style: 'normal', status: 'loaded'},
        {family: 'Visuelt', weight: '700', style: 'normal', status: 'loaded'},
        {family: 'Tiempos Text', weight: '400', style: 'normal', status: 'unloaded'},
    ],
    ...over,
});

/**
 * ALPHA IS NOT A COLOUR. Four of natwest.com's eighteen colour values were the same four
 * colours at a second opacity; counting those as separate reports a drift where there is a
 * deliberate choice.
 */
test('a colour used at two opacities is one colour, and its areas add', () => {
    const got = styleRecord(collected());
    assert.equal(got.colours.values, 3, 'three values were seen');
    assert.equal(got.colours.total, 2, 'of two colours');
    assert.equal(got.colours.palette[0].colour, 'rgb(90, 40, 125)');
    assert.equal(got.colours.palette[0].area, 1500, 'both opacities are that colour being used');
});

test('only groups of more than one are an inconsistency', () => {
    const got = styleRecord(collected());
    assert.deepEqual(got.colours.sameColour, [], 'two distinct colours are not a drift');

    const drifting = styleRecord(collected({
        colours: [c('rgb(64, 64, 64)', 900), c('rgb(68, 68, 68)', 10)],
    }));
    assert.deepEqual(drifting.colours.sameColour, [['rgb(64, 64, 64)', 'rgb(68, 68, 68)']]);
});

test('the threshold the clustering used is part of the record', () => {
    assert.equal(styleRecord(collected()).colours.deltaE, SAME_COLOUR_DE);
    assert.equal(styleRecord(collected(), 1).colours.deltaE, 1);
});

/** Declared, loaded and rendered are three different numbers. kohde.agency: 7, 5 and 2. */
test('fonts count declared, loaded and rendered separately', () => {
    const got = styleRecord(collected());
    assert.equal(got.fonts.declared, 3);
    assert.equal(got.fonts.loaded, 2, 'a face nothing needed was never fetched');
    assert.deepEqual(got.fonts.families, ['Visuelt'], 'one family, at two weights');
    assert.equal(got.fonts.rendered[0].family, 'Visuelt');
});

/**
 * natwest.com renders with `knile`, `knilebold` and `knileblack` — one typeface wearing
 * three family names, where kohde.agency's Visuelt carries its weights as weights. The
 * record keeps the names as they are; a count alone calls the first three and the second
 * one, and has it backwards.
 */
test('weights masquerading as families are recorded as the page names them', () => {
    const got = styleRecord(collected({
        faces: [
            {family: 'knile', weight: 'normal', style: 'normal', status: 'loaded'},
            {family: 'knilebold', weight: 'normal', style: 'normal', status: 'loaded'},
            {family: 'knileblack', weight: 'normal', style: 'normal', status: 'loaded'},
        ],
    }));
    assert.equal(got.fonts.families.length, 3);
    assert.deepEqual(got.fonts.families, ['knile', 'knilebold', 'knileblack']);
});

test('a census that returned nothing is declared unmeasured, not empty', () => {
    assert.equal(styleRecord(null).measured, false);
    assert.equal(styleRecord({}).measured, false);
    assert.match(styleRecord(null).why, /returned nothing/);
});

test('a page with no colours at all does not throw', () => {
    const got = styleRecord({colours: [], faces: [], fontSizes: [], renderedFamilies: []});
    assert.equal(got.measured, true);
    assert.equal(got.colours.total, 0);
    assert.deepEqual(got.colours.sameColour, []);
    assert.equal(got.fonts.declared, 0);
});

/**
 * THE BUG A SMOKE TEST FOUND, and it was visible in the output before it was visible in a
 * test. getComputedStyle does not always answer in `rgb()`: boondmanager.com returns
 * `color(srgb 0.156863 0.172549 0.196078)` and visionarygrid.studio `color(srgb 1 1 0.835)`.
 * Taking the first three numbers out of those reads 0-1 values as 0-255, so white arrived
 * as near-black and was clustered with a dark grey as "the same colour twice".
 *
 * COLLECT_STYLES now paints every value to a canvas and reads the pixel back, so this
 * function only ever sees sRGB. The guard is the second line of defence: a value it cannot
 * read is refused rather than silently mangled.
 */
test('a colour outside sRGB range is refused, not mangled into a dark one', () => {
    assert.deepEqual(channels('color(srgb 1 1 0.835)'), [], 'fractional channels are not 0-255');
    assert.deepEqual(channels('color(srgb 0.156863 0.172549 0.196078)'), []);
    assert.deepEqual(channels('rgb(300, 0, 0)'), [], 'and nor is anything over 255');
    assert.deepEqual(channels('rgb(255, 255, 255)'), [255, 255, 255], 'a real one still reads');
});
