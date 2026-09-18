/**
 * SLICES
 *
 *   node --test tools/audit/test/slices.test.mjs
 *
 * The capture photographs the page a viewport at a time and censuses each band beside its
 * own shot. This file checks the arithmetic of that on its own, and then checks the whole
 * thing against a local page BUILT TO HAVE THE STRUCTURE UNDER TEST — a sticky header, a
 * fixed bar, a section that is only in position while it is on screen, and a panel that is
 * behind an `opacity: 0` ancestor at every scroll position there is.
 *
 * THE PREMISE IS PROVED IN THE SAME FILE. Every claim about the stitched capture is made
 * against the single full-page shot of the same page, captured by the same function down
 * its fallback path: the control shows the reveal missing and its elements marked
 * transparent, which is the defect, and the stitched capture shows it painted. A test that
 * only asserted the good outcome would pass just as well against a page with nothing to
 * reveal.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {
    budget, withDeadline, slicePlacement, unionRects, stitchSlices, capturePage, VIEWPORT,
} from '../lib/capture.mjs';
import {paintLimitWarning, PAINT_LIMIT_PX} from '../lib/unrendered.mjs';

/* ---------------------------------------------------------------- the budget */

test('a budget reports what is left and refuses a step once it is spent', () => {
    let now = 1000;
    const clock = budget(500, () => now);
    assert.equal(clock.left(), 500);
    now += 300;
    assert.equal(clock.check('a step with time for it'), 200);
    now += 200;
    assert.throws(() => clock.check('a step there is no time for'), /500ms capture budget was spent/);
});

test('a step that never finishes is given up on rather than waited for', async () => {
    // The whole reason the budget exists: page.evaluate has no timeout of its own, and a
    // page that never returns from one held a capture for fourteen minutes.
    await assert.rejects(
        withDeadline(new Promise(() => {}), 10, 'a step that never returns'),
        /a step that never returns did not finish within 10ms/,
    );
});

test('a step that finishes in time is simply its own value', async () => {
    assert.equal(await withDeadline(Promise.resolve('done'), 1000, 'a quick step'), 'done');
});

test('losing the race does not leave an unhandled rejection behind', async () => {
    // A stuck evaluate rejects LATER, when the browser is closed underneath it. Nothing
    // is listening by then, and an unhandled rejection takes the process down after the
    // error has already been reported properly.
    let fail;
    const late = new Promise((_, reject) => {
        fail = reject;
    });
    await assert.rejects(withDeadline(late, 5, 'a step'), /did not finish/);
    fail(new Error('the browser went away'));
    await new Promise((resolve) => setTimeout(resolve, 20));
});

/* ------------------------------------------------------------ slice placement */

test('slices of a page that is an exact multiple of the viewport do not overlap', () => {
    assert.deepEqual(slicePlacement(0, 0, 1800, 900), {top: 0, skip: 0, height: 900});
    assert.deepEqual(slicePlacement(900, 900, 1800, 900), {top: 900, skip: 0, height: 900});
});

test('the last slice is cropped rather than laid over the one before it', () => {
    // A 1296px page: the browser clamps the second scroll to 396, so the shot is of rows
    // 396-1296 and 396-900 of it are already written.
    assert.deepEqual(slicePlacement(396, 900, 1296, 900), {top: 900, skip: 504, height: 396});
});

test('a shot that adds nothing to the image is not taken', () => {
    // The page stopped scrolling — an inner scroller, a scroll lock — so this shot is the
    // previous one again. Placing it would duplicate a band; the pass stops instead.
    assert.equal(slicePlacement(900, 1800, 3000, 900), null);
});

test('a page shorter than the viewport is cropped to the page', () => {
    assert.deepEqual(slicePlacement(0, 0, 400, 900), {top: 0, skip: 0, height: 400});
});

/* --------------------------------------------------------------- the census */

const r = (over = {}) => ({x: 0, y: 0, w: 100, h: 50, tag: 'div', text: '', boxed: false, ...over});

test('a rect seen in two bands is one rect', () => {
    const header = r({tag: 'header', h: 60});
    assert.deepEqual(unionRects([[header], [header]]), [header]);
});

test('nesting is not unwound: two coincident rects in one band stay two', () => {
    // An element's text includes its descendants', a wrapper and the paragraph inside it
    // both count, and lib/painted.mjs's thresholds were measured against that definition.
    const box = r({tag: 'div', w: 200, h: 200});
    assert.equal(unionRects([[box, box]]).length, 2);
    assert.equal(unionRects([[box, box], [box]]).length, 2, 'and the later band does not reduce it');
    assert.equal(unionRects([[box], [box, box]]).length, 2, 'whichever order they arrive in');
});

test('one element seen at two positions is kept at both', () => {
    // tpagency.com moves content into place only while its region is on screen. The two
    // positions are two different rows of the image, and each band offers only what it
    // saw while its own rows were being photographed.
    const low = r({y: 1869, text: 'moved'});
    const high = r({y: 3000, text: 'moved'});
    assert.deepEqual(unionRects([[low], [high]]), [low, high]);
});

test('the union is in order of first sight, so the same slices always give the same file', () => {
    const a = r({y: 10, text: 'a'});
    const b = r({y: 20, text: 'b'});
    const c = r({y: 30, text: 'c'});
    assert.deepEqual(unionRects([[a, b], [b, c]]), [a, b, c]);
});

/* --------------------------------------------------------------- the stitch */

const solid = (colour, height = 900, width = 120) => sharp({
    create: {width, height, channels: 3, background: {r: colour[0], g: colour[1], b: colour[2]}},
}).png().toBuffer();

const rowColour = async (png, y) => {
    const {data, info} = await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const p = (y * info.width + Math.floor(info.width / 2)) * 3;

    return [data[p], data[p + 1], data[p + 2]];
};

test('the slices land in the image in the order and at the offsets they were given', async () => {
    const parts = [
        {buffer: await solid([255, 0, 0]), top: 0, skip: 0, height: 900},
        {buffer: await solid([0, 255, 0]), top: 900, skip: 0, height: 900},
    ];
    const png = await stitchSlices(parts, 120, 1800);
    assert.deepEqual(await sharp(png).metadata().then((m) => [m.width, m.height]), [120, 1800]);
    assert.deepEqual(await rowColour(png, 0), [255, 0, 0]);
    assert.deepEqual(await rowColour(png, 899), [255, 0, 0]);
    assert.deepEqual(await rowColour(png, 900), [0, 255, 0]);
    assert.deepEqual(await rowColour(png, 1799), [0, 255, 0]);
});

test('an overlapping last slice contributes only the rows it was asked for', async () => {
    // The second shot is of rows 396-1296 and the first 504 of it are already written, so
    // only its bottom 396 rows may reach the image. Its top half is a different colour so
    // that painting it over the first slice would be visible rather than merely wasteful.
    const parts = [
        {buffer: await solid([255, 0, 0]), top: 0, skip: 0, height: 900},
        {
            buffer: await sharp({create: {width: 120, height: 900, channels: 3, background: {r: 0, g: 0, b: 255}}})
                .composite([{
                    input: await solid([0, 255, 0], 396),
                    top: 504,
                    left: 0,
                }]).png().toBuffer(),
            top: 900,
            skip: 504,
            height: 396,
        },
    ];
    const png = await stitchSlices(parts, 120, 1296);
    assert.deepEqual(await sharp(png).metadata().then((m) => m.height), 1296);
    assert.deepEqual(await rowColour(png, 899), [255, 0, 0], 'the overlap band is the first slice, not the second');
    assert.deepEqual(await rowColour(png, 900), [0, 255, 0]);
    assert.deepEqual(await rowColour(png, 1295), [0, 255, 0]);
});

test('there is no image to be made from no slices', async () => {
    await assert.rejects(stitchSlices([], 120, 900), /no slices to stitch/);
});

/* --------------------------------------------------------- the paint limit */

test('a page past the paint limit taken in one shot is still refused', () => {
    const meta = {fullHeight: PAINT_LIMIT_PX + 100, capture: {mode: 'fullpage'}};
    assert.match(paintLimitWarning(meta), /stops painting/);
});

test('the paint limit does not apply to a page that was photographed a viewport at a time', () => {
    // Every slice is a viewport shot, far below any texture limit. A warning claiming a
    // limitation that no longer applies is worse than no warning: it is read and believed.
    const meta = {fullHeight: PAINT_LIMIT_PX + 100, capture: {mode: 'stitched', slices: 28}};
    assert.equal(paintLimitWarning(meta), null);
});

test('a capture with no record of how it was taken is assumed to be one shot', () => {
    assert.match(paintLimitWarning({fullHeight: PAINT_LIMIT_PX + 100}), /stops painting/);
});

/* ------------------------------------------------- a real page, both ways */

/**
 * A page with every shape the slice pass exists for, and nothing else. Six slices.
 *
 *   - a FIXED header and a FIXED bar, which a slice pass repeats once per slice unless it
 *     hides them;
 *   - a STICKY NAV pinned down the whole page showing the same thing at every offset,
 *     which is the jerseyfinance / hsbc / klark regression: `position` cannot tell it from
 *     the panel below, and it must be hidden after the first slice all the same;
 *   - a PINNED sticky panel across two viewports THAT SWAPS ITS CONTENT per viewport,
 *     which must NOT be hidden — the visitor spends two viewports on it and the page
 *     spends 1800px of scroll height on it;
 *   - a CARD HELD IN THE VIEWPORT BY SCRIPT while computing `position: relative`, which is
 *     boondmanager.com's consent card: no CSS rule can find it, it repeated twelve times,
 *     and `consentBannerSeen` was false on a page carrying it;
 *   - a REVERSIBLE reveal: a section whose opacity is 0 unless it is on screen, which is
 *     the tpagency.com mechanism and is invisible to a shot taken from the top;
 *   - a panel behind an `opacity: 0` ancestor at every scroll position, which no capture
 *     can reach and which must therefore be RECORDED AND FLAGGED rather than dropped.
 *
 * WHY THE PINNED PANEL SWAPS ITS CHIPS. Task 14 built this panel as a flat magenta block
 * and hid it on the strength of `position: sticky` alone; Task 15 replaced that test with
 * a measurement of whether the element draws the SAME PIXELS at every offset, which a flat
 * block does. The real panel this one stands for — tpagency.com's — swaps a line of text
 * per viewport, and that is precisely why it is content and a nav bar is not. The chips
 * are narrow (120px of a 1440px row) so that the rows they sit in are still 91% magenta
 * and the row count below measures the same thing it always did.
 */
const PAGE = `<!doctype html><html><head><title>Slice me</title><style>
 body{margin:0;font:16px sans-serif}
 header{position:fixed;top:0;left:0;width:100%;height:60px;background:rgb(255,0,0);color:#fff}
 .bar{position:fixed;bottom:0;left:0;width:100%;height:40px;background:rgb(0,0,255);color:#fff}
 #page{padding-top:60px}
 .nav{position:sticky;top:60px;height:40px;background:rgb(255,140,0);color:#fff;z-index:5}
 section{height:900px}
 #reveal{background:rgb(20,20,20);opacity:0}
 #reveal.on{opacity:1}
 .card{height:100px;background:rgb(0,128,0);color:#fff}
 #pin{height:1800px}
 #pin .panel{position:sticky;top:0;height:900px;background:rgb(200,0,200);color:#fff}
 #pin .chip{width:120px;height:40px;margin:0 0 0 20px;background:rgb(0,255,80)}
 #ghost{opacity:0}
 #held{position:relative;width:240px;height:120px;background:rgb(0,200,200);color:#003}
 /* A DESCENDANT THAT KEEPS ITSELF VISIBLE, which is the ordinary way a widget or a
    scroll-reveal is written — and which ignores a hide applied only to its ancestor. */
 #held p{visibility:visible;margin:0;width:240px;height:120px;background:rgb(0,200,200)}
</style></head><body>
 <header>FIXED HEADER</header>
 <div id="page">
  <div class="nav">STICKY NAV</div>
  <section style="background:#fff">one</section>
  <section style="background:#eee">two</section>
  <section id="reveal">${Array.from({length: 8}, (_, i) => `<div class="card">card ${i}</div>`).join('')}</section>
  <div id="pin"><div class="panel">PINNED PANEL${
    Array.from({length: 8}, () => '<div class="chip"></div>').join('')
}</div></div>
  <section style="background:#ddd">four
    <div id="ghost">${Array.from({length: 8}, (_, i) => `<p>ghost ${i}</p>`).join('')}</div>
  </section>
 </div>
 <div class="bar">FIXED BAR</div>
 <div id="held"><p>We use cookies.</p></div>
 <script>
  const target = document.querySelector('#reveal');
  new IntersectionObserver((entries) => {
    for (const e of entries) target.classList.toggle('on', e.isIntersecting);
  }).observe(target);

  // The boondmanager.com mechanism: an ordinary in-flow element kept in the viewport by
  // a scroll handler. Its computed position is 'relative' at every offset.
  const held = document.querySelector('#held');
  const flow = held.offsetTop;
  const hold = () => { held.style.top = (window.scrollY + 500 - flow) + 'px'; };
  addEventListener('scroll', hold, {passive: true});
  hold();

  // The tpagency.com mechanism: the pinned panel shows something different in each
  // viewport it is pinned across.
  const chips = [...document.querySelectorAll('#pin .chip')];
  const swap = () => {
    const colour = Math.floor(window.scrollY / 900) % 2 ? 'rgb(0,80,255)' : 'rgb(0,255,80)';
    for (const chip of chips) chip.style.background = colour;
  };
  addEventListener('scroll', swap, {passive: true});
  swap();
 </script>
</body></html>`;

/** Captured once each way and shared: a capture is several seconds and every test below asks about the same two. */
const captures = (() => {
    let pending = null;

    return () => (pending ??= (async () => {
        const dir = mkdtempSync(join(tmpdir(), 'audit-slices-'));
        const file = join(dir, 'index.html');
        writeFileSync(file, PAGE);
        const url = `file://${file}`;
        const stitchedDir = join(dir, 'stitched');
        const controlDir = join(dir, 'control');

        const stitched = await capturePage(url, stitchedDir);
        // THE CONTROL IS THE OLD BEHAVIOUR, taken down the fallback path: no slices at all
        // means there is nothing to stitch, so the capture falls back to the single
        // full-page shot from the top that this whole change replaces.
        const control = await capturePage(url, controlDir, {maxSlices: 0});

        const read = (d, meta) => ({
            meta,
            dir: d,
            rects: JSON.parse(readFileSync(join(d, 'rects.json'), 'utf8')),
        });

        return {stitched: read(stitchedDir, stitched), control: read(controlDir, control)};
    })());
})();

/** Rows in which at least `share` of the pixels are within 12 of `colour`. */
async function rowsOfColour(path, colour, share = 0.5) {
    const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const rows = [];
    for (let y = 0; y < info.height; y++) {
        let hit = 0;
        for (let x = 0; x < info.width; x++) {
            const p = (y * info.width + x) * 3;
            if (Math.abs(data[p] - colour[0]) <= 12
                && Math.abs(data[p + 1] - colour[1]) <= 12
                && Math.abs(data[p + 2] - colour[2]) <= 12) hit++;
        }
        if (hit >= info.width * share) rows.push(y);
    }

    return rows;
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 128, 0];
const MAGENTA = [200, 0, 200];
const ORANGE = [255, 140, 0];
const CYAN = [0, 200, 200];

test('the premise: a single shot from the top misses a reveal that is only in place on screen', async () => {
    const {control} = await captures();
    assert.equal(control.meta.capture.mode, 'fullpage', 'the control must be the old path');
    assert.match(control.meta.capture.fallbackReason, /no slices to stitch/);
    const green = await rowsOfColour(join(control.dir, 'fullpage.png'), GREEN, 0.9);
    assert.equal(green.length, 0, 'the reveal is not in the control image at all');
});

test('the stitched capture contains the reveal the single shot missed', async () => {
    const {stitched} = await captures();
    assert.equal(stitched.meta.capture.mode, 'stitched');
    assert.ok(stitched.meta.capture.slices >= 4, `a 5400px page is several slices: ${stitched.meta.capture.slices}`);
    const green = await rowsOfColour(join(stitched.dir, 'fullpage.png'), GREEN, 0.9);
    assert.ok(green.length > 700, `eight 100px cards should be painted, got ${green.length} rows`);
});

test('the stitched image is the height of the page, and the two agree about it', async () => {
    const {stitched} = await captures();
    assert.equal(stitched.meta.image.width, VIEWPORT.width);
    assert.equal(stitched.meta.image.height, stitched.meta.fullHeight);
});

test('a fixed header appears once, not once per slice', async () => {
    // Left alone, a fixed header is stuck to the top of every viewport and lands in the
    // image once per slice down the whole page.
    const {stitched} = await captures();
    const red = await rowsOfColour(join(stitched.dir, 'fullpage.png'), RED, 0.9);
    assert.ok(red.length > 0, 'the header is in the image');
    assert.ok(red.length <= 70, `one 60px header, not one per slice: ${red.length} rows`);
    assert.ok(red[0] <= 1, `and at the top of the page, where it belongs: ${red[0]}`);
});

test('a fixed bar appears once, not once per slice', async () => {
    const {stitched} = await captures();
    const blue = await rowsOfColour(join(stitched.dir, 'fullpage.png'), BLUE, 0.9);
    assert.ok(blue.length > 0 && blue.length <= 50, `one 40px bar: ${blue.length} rows`);
});

test('a PINNED panel is kept in every band it is pinned across', async () => {
    // THE OPPOSITE RULING TO THE TWO ABOVE, and it was got wrong once already: hiding
    // sticky elements alongside fixed ones took 4,000px of tpagency.com — 45% of that
    // page — to pure black, because the section is a pinned scrollytelling panel. The
    // visitor spends two viewports on this one and the page spends 1800px of scroll
    // height on it, so the image should spend 1800px on it too.
    const {stitched} = await captures();
    const pinned = await rowsOfColour(join(stitched.dir, 'fullpage.png'), MAGENTA, 0.9);
    assert.ok(pinned.length > 1700, `the panel is pinned across two viewports: ${pinned.length} rows`);
});

test('a sticky nav showing the same thing at every offset appears once', async () => {
    // THE TASK 15 REGRESSION, in miniature. This bar and the panel above it are both
    // `position: sticky` and both hold the viewport; nothing in the stylesheet separates
    // them. What does is that this one draws the same pixels wherever it is pinned, and
    // the panel does not. Left alone it paints over the middle of whatever the page has
    // at each slice boundary — on jerseyfinance.com, across a paragraph.
    const {stitched} = await captures();
    const nav = await rowsOfColour(join(stitched.dir, 'fullpage.png'), ORANGE, 0.9);
    assert.ok(nav.length > 0, 'the nav is in the image');
    assert.ok(nav.length <= 50, `one 40px nav, not one per slice: ${nav.length} rows`);
    assert.ok(nav[0] < VIEWPORT.height, `and in the first viewport, where it belongs: ${nav[0]}`);
});

test('an element held in the viewport BY SCRIPT appears once, though no CSS says so', async () => {
    // boondmanager.com's consent card: a direct child of <body> computing
    // `position: relative`, kept on screen by a scroll handler. Every rule this capture
    // had asked the stylesheet, so it painted twelve times down a 10,000px page.
    const {stitched} = await captures();
    const card = await rowsOfColour(join(stitched.dir, 'fullpage.png'), CYAN, 0.1);
    assert.ok(card.length > 0, 'the card is in the image');
    assert.ok(card.length <= 130, `one 120px card, not one per slice: ${card.length} rows`);
});

test('a banner held in the viewport by script is SEEN, though no CSS says it is a banner', async () => {
    // The other half of the same defect, and the more damaging one: a candidate had to sit
    // under a fixed or sticky ancestor to be considered, so `consentBannerSeen` was false
    // on a page with a consent card in plain sight — the audit then reported nothing about
    // a wall the visitor has to get past.
    const {stitched} = await captures();
    assert.equal(stitched.meta.consentBannerSeen, true);
    assert.equal(stitched.meta.consentDismissed, false, 'this card has no accept control, and is left alone');
});

test('meta.fixed records an element no stylesheet calls fixed', async () => {
    // What `heightGap` reads to name the cause of a region nothing accounts for. It used to
    // be a list of `position: fixed` elements and nothing else, so a card held in the
    // viewport by script was in no record this capture produced.
    const {stitched} = await captures();
    const held = stitched.meta.fixed.filter((f) => f.via === 'pinned');
    assert.ok(held.length > 0, `something here is pinned without being fixed: ${JSON.stringify(stitched.meta.fixed)}`);
    assert.ok(
        stitched.meta.fixed.some((f) => f.via === 'both' || f.via === 'fixed'),
        'and position:fixed is still collected beside it',
    );
});

test('meta records what was measured as pinned and what was decided about it', async () => {
    const {stitched} = await captures();
    const pinned = stitched.meta.capture.pinned;
    assert.ok(pinned.pinned > 0, 'something on this page holds the viewport');
    assert.ok(pinned.chrome >= 4, `the header, bar, nav and card all repeat: ${pinned.chrome}`);
    const verdicts = pinned.elements.map((e) => e.verdict);
    assert.ok(verdicts.includes('content'), 'and the panel that swaps its content does not');
    // The decision is made on pixels, so every element carries the number it was made on.
    for (const element of pinned.elements) {
        assert.ok(element.compared > 0 || element.verdict === 'undecided', JSON.stringify(element));
    }
});

test('the census finds the revealed content the shot from the top cannot', async () => {
    const {stitched, control} = await captures();
    // Anchored at both ends: the section holding the eight cards carries all eight card
    // texts run together, so a loose match counts the container as a ninth card.
    const cards = (rects) => rects.filter((rect) => /^card \d$/.test(rect.text));
    assert.equal(cards(stitched.rects).length, 8, 'every card is censused');
    assert.equal(
        cards(stitched.rects).filter((rect) => rect.transparentAncestor === true).length,
        0,
        'and none of them is behind a transparent ancestor, because its band was censused on screen',
    );

    // THE SAME ELEMENTS, from the top: present, and every one of them transparent. That
    // is the difference the flag exists to record.
    assert.equal(cards(control.rects).length, 8, 'a dropped element is indistinguishable from an absent one');
    assert.equal(
        cards(control.rects).filter((rect) => rect.transparentAncestor === true).length,
        8,
        'the single shot sees all eight behind an opacity:0 ancestor',
    );
});

test('content behind a transparent ancestor at every scroll position is recorded and flagged', async () => {
    // No capture can reach this panel: it is not gated on scroll, it is simply invisible.
    // Dropping it would make it indistinguishable from a page with nothing there, which is
    // the answer this tool must never give wrongly.
    const {stitched} = await captures();
    const ghosts = stitched.rects.filter((rect) => /^ghost \d/.test(rect.text));
    assert.equal(ghosts.length, 8);
    assert.ok(ghosts.every((rect) => rect.transparentAncestor === true), 'every one of them is flagged');
});

test('meta says how the capture was taken and what the census cost', async () => {
    const {stitched} = await captures();
    assert.equal(stitched.meta.capture.fallbackReason, null);
    assert.equal(stitched.meta.capture.stoppedEarly, null);
    assert.equal(stitched.meta.capture.viewportHeight, VIEWPORT.height);
    assert.equal(stitched.meta.capture.rects, stitched.rects.length);
    assert.ok(stitched.meta.capture.rectsAtTop > 0, 'the census a single shot would have taken is recorded beside it');
});
