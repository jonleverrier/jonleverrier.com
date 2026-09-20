/**
 * CAPTURE (phase 1)
 *
 * Load a URL at a fixed 1440×900, make lazy content load, and write the two
 * screenshots plus the DOM rects that phase 2 is checked against.
 *
 *   node tools/audit/capture.mjs <url> [outDir]
 *
 * THE PAGE IS PHOTOGRAPHED A VIEWPORT AT A TIME AND THE SLICES ARE STITCHED, because
 * `page.screenshot({fullPage: true})` is one shot taken from scroll position 0 and that
 * is wrong for three independent reasons:
 *
 *   - Scroll-reveal content is not in its revealed state. boondmanager.com holds a
 *     section inside a `<div class="solutions-slider_tabs">` whose computed opacity is 0;
 *     every child reports `opacity: 1` on its own, so all of them land in rects.json over
 *     an empty dark panel. It is not reduced motion (a capture with `no-preference` is
 *     pixel-identical), not a backgrounded page (rAF runs, IO fires) and not dwell time
 *     (longer dwell is measurably WORSE).
 *   - Scroll-reveal content is not always in POSITION either, and that half is reversible.
 *     tpagency.com's void at y=1869–5890 holds 2 elements when the page is at the top and
 *     12 when it is scrolled to y=3000, with the element count for the whole document
 *     unchanged at 306 throughout: nothing is created, things are moved into place while
 *     the region is on screen and slide back out when it is not.
 *   - Chromium stops painting a full-page screenshot at 16,384px. visionarygrid.studio is
 *     24,746px: the PNG was the full height with content stopping dead at y=16,382.
 *
 * A viewport shot taken while scrolled to the offset has none of those problems, so the
 * capture is a sequence of those composited into one image — AND THE DOM CENSUS IS TAKEN
 * THE SAME WAY, one band at a time, at the same scroll position as the shot that owns
 * those rows. A single census at scroll 0 against a stitched image would compare a
 * correct picture with an incomplete list and conclude that the picture was wrong.
 *
 * ANYTHING THAT HOLDS THE VIEWPORT WHILE THE PAGE SCROLLS UNDER IT is photographed once per
 * slice and would land in the image ten or twenty times, so it is hidden after the first
 * one. WHICH elements those are is MEASURED rather than read off `position` — see
 * lib/pinned.mjs, which is where that whole decision and the reasons for it live. The
 * census rides along on the scroll pass below; the decision costs one or two extra pairs of
 * screenshots before the slicing starts.
 *
 * EVERY WALK CROSSES OPEN SHADOW ROOTS. A `querySelectorAll('body *')` stops at a component
 * boundary, so a card a page builds inside one was painted and censused as nothing at all —
 * see lib/shadow.mjs for the measurement. The walk is installed on the page before its own
 * scripts run, and this file REFUSES TO CONTINUE without it.
 *
 * THE CONSENT BANNER IS ASKED FOR TWICE: once at load, and once after the scroll pass for a
 * banner that was not there the first time. boondmanager.com's opens about eight seconds in.
 * The second attempt is narrower about what it will click — see lib/consent.mjs.
 *
 * `meta.capture` records which path ran, how many slices it took, how many rects the
 * banded census found against what a single one at the top would have, what the pinned
 * census decided about each element it found, how much of the page is behind a component
 * boundary, what each consent attempt cost, and the reason if it fell back to a single
 * shot.
 *
 * WHAT THIS STILL DOES NOT SEE, and must not be read as solving: the slice pass reaches
 * what SCROLLING reveals. Content behind a hover, a click, a tab, a carousel step or a
 * timer is reached by none of it. The two mechanisms above were found by meeting them;
 * any list of mechanisms is only the ones we have happened to meet.
 *
 * The other two limitations, both declared rather than fixed:
 *
 *   - prefers-reduced-motion is forced, because a carousel or an entrance animation makes
 *     the capture non-deterministic and phase 2 has to be deterministic. Content gated
 *     behind that query is therefore absent — and it is NOT true, as this comment used to
 *     claim, that the resting state is "what most visitors see": most visitors do not
 *     have reduced motion set, so they get the thing we skipped.
 *   - There is no GPU, so WebGL falls back to SwiftShader, and sites that check for that
 *     decline to render rather than push a heavy scene through a software rasteriser. See
 *     lib/webgl.mjs — `meta.webgl` records it so the report can decline to answer for that
 *     region instead of measuring a hole as empty space.
 */
import {chromium} from 'playwright';
import sharp from 'sharp';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {dismissConsent, dismissLateConsent} from './consent.mjs';
import {SHADOW_CENSUS, SHADOW_INIT} from './shadow.mjs';
import {WEBGL_PROBE_INIT, probeWebgl} from './webgl.mjs';
import {COLLECT_PINNED, heightGap} from './unrendered.mjs';
import {countBytes} from './bytes.mjs';
import {
    BEGIN_PIN, HIDE_PINNED, MARK_PINNED, MEASURE_BOXES, RESTORE_HIDDEN,
    decideChrome, markEarlyPinned, newCensus, recordStep,
} from './pinned.mjs';

/**
 * How long the one scroll taken BEFORE the consent banner is dismissed gets to settle.
 *
 * Shorter than a slice's settle on purpose. Its only job is to widen the set of controls
 * lib/consent.mjs will consider — see markEarlyPinned — so anything it misses costs the
 * capture nothing that it was not already missing, and it is paid on every page.
 */
export const EARLY_SETTLE_MS = 200;

export const VIEWPORT = {width: 1440, height: 900};

/**
 * The whole wall-clock budget for one capture, and the reason it exists.
 *
 * bakerandpartners.com blocked a capture for FOURTEEN MINUTES on 0.60s of CPU before it
 * was killed by hand. `goto` has a timeout and `waitForLoadState` has one; every
 * `page.evaluate` and every `screenshot` has none, because Playwright applies no default
 * there — and there are five evaluates, three of them inside a loop that runs up to forty
 * times. On a CLI that is something you Ctrl-C. In the Craft queue job it occupies a
 * worker for ever and the prospect who submitted that URL never receives an email.
 *
 * Three minutes is deliberately generous: the slowest honest capture measured on this
 * branch is a 24,746px page at a little over a minute end to end, so the budget is
 * several times the worst real case and will only ever be reached by something stuck.
 */
export const CAPTURE_BUDGET_MS = 180000;

/**
 * How long a slice is given to settle after its scroll, before it is photographed.
 *
 * It has to outlast the compositor and the entrance transition the scroll itself starts,
 * and it is the one number in this file that changes what a page measures as.
 *
 * MEASURED over the whole 29-site sweep, captured twice: at 200ms and at 400ms. The note
 * set differs on TWO sites and in both cases 400ms is the better answer —
 * altumgroup.com's `contentNotPainted` goes away (reproduced 3 times at each value: 3/3
 * flagged at 200, 0/3 at 400; cropped and looked at, the region is a fade-in caught part
 * way through, real content at a few per cent opacity) and jerseyfinance.com's
 * `contentTransparent` goes away. Nothing gains a note. The cost is 476s against 525s
 * across all 29 captures, about 10%.
 *
 * WHAT POINTS THE OTHER WAY, because it is the only thing that does: boondmanager.com was
 * flagged `contentNotPainted` in 1 of 3 isolated runs at 400ms and 0 of 3 at 200ms, and
 * its measured page height wanders by a few pixels at 400 where it is stable at 200 —
 * longer dwell lets more lazy content land. Two sites fixed against one made occasionally
 * flaky is the trade this number is set on, and it is a trade rather than a free win.
 */
export const SLICE_SETTLE_MS = 400;

/**
 * How long a tidy-up step gets, whatever is left of the budget.
 *
 * Putting hidden elements back and getting to the top of the page before the fallback shot
 * both run on the way out of a failure, and the failure they most often follow is a page
 * that stopped answering. Charging them to the capture's budget would be no protection at
 * all when that budget is what has just run out.
 */
export const CLEANUP_MS = 5000;

/**
 * A wall-clock budget, as an object that can be asked how much is left.
 *
 * Separate from the clock so it can be tested without waiting: `now` is injectable.
 * `check` THROWS rather than returning a flag, because every caller of it is a step that
 * must not start when there is no time for it, and a budget that can be ignored by
 * forgetting an `if` is not a budget.
 */
export function budget(ms, now = Date.now) {
    const end = now() + ms;

    return {
        left: () => end - now(),
        check(what) {
            const left = end - now();
            if (left <= 0) {
                throw new Error(`the ${ms}ms capture budget was spent before ${what}`);
            }

            return left;
        },
    };
}

/**
 * `promise`, or a rejection once `ms` has passed.
 *
 * The loser of the race is deliberately given its own handler: a `page.evaluate` that is
 * still stuck when the browser is closed underneath it rejects LATER, and an unhandled
 * rejection would take the process down after the error had already been reported
 * properly.
 */
export function withDeadline(promise, ms, what) {
    const guarded = Promise.resolve(promise);
    guarded.catch(() => {});

    let timer = null;
    const bell = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
        // Never hold the process open for a timer that is only ever a safety net.
        if (typeof timer.unref === 'function') timer.unref();
    });

    return Promise.race([guarded, bell]).finally(() => clearTimeout(timer));
}

/**
 * How tall the page is, measured the way the screenshot measures it. Runs IN the page.
 *
 * `document.body.scrollHeight` is NOT the page height and was used here for all three of
 * "how far is there left to scroll", "how tall is the page" and the denominator of the
 * unmeasured-region check. On example.com it says 96 while the full-page screenshot is
 * 900 tall; on the standard app-shell homepage — `html, body { height: 100% }` with an
 * inner scrolling div — it says one viewport whatever the content, so the scroll loop
 * concluded it was already at the bottom on its first pass and no lazy content ever
 * loaded. No warning, exit 0: the silent kind of wrong.
 *
 * The larger of the two is what Chromium's fullPage screenshot uses, so this is the
 * number the image phase 2 divides by actually has.
 */
export const PAGE_HEIGHT = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0,
);

/**
 * How wide the page is, measured the same way. Runs IN the page.
 *
 * RECORDED BECAUSE THE STITCHED IMAGE IS EXACTLY THE VIEWPORT WIDTH and a full-page
 * screenshot was not. lloydsbank.com's page is 1469px wide, so the old capture produced a
 * 1469px image and phase 2 measured 29px of horizontal overflow that a 1440px visitor has
 * to scroll sideways to see; the stitched one is 1440px and does not. Neither answer is
 * obviously wrong — the viewport is locked at 1440 and every fixture is that width — but
 * the difference must be visible rather than silently decided, so the page's own width
 * goes in `meta.capture` beside the image's.
 */
export const PAGE_WIDTH = () => Math.max(
    document.documentElement ? document.documentElement.scrollWidth : 0,
    document.body ? document.body.scrollWidth : 0,
);

/**
 * A PNG's own pixel dimensions, straight out of its IHDR header.
 *
 * Read so that meta can carry the image's height beside the page's. They should agree;
 * when they do not, the screenshot was truncated (Chromium has a limit, and a page can
 * grow between the measure and the shot) and every percentage phase 2 produces is of a
 * prefix of the page. That was previously undetectable after the browser had closed.
 */
export function pngSize(buffer) {
    // 8-byte signature, then the IHDR chunk: 4-byte length, the type, width, height.
    if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
        throw new Error('not a PNG: no IHDR where one must be');
    }

    return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

/**
 * Collect rects for every visible element. Runs IN the page.
 *
 * `band` is `{top, bottom}` in page coordinates, or null for the whole document. It is
 * what makes a census per slice affordable: the cheap test — a bounding box the browser
 * has already laid out — comes first, and only an element that is in the band pays for
 * `getComputedStyle` and the ancestor walks. The band is also what makes the census
 * HONEST on a page that moves its content around, because each band is collected at the
 * scroll position of the shot that owns those rows.
 *
 * THE WALK CROSSES SHADOW BOUNDARIES, both down and up. `querySelectorAll('body *')` stops
 * at a shadow root, so a page's web components were painted and censused as nothing; and
 * `parentElement` stops there too, so the clipping and opacity walks below read the
 * component as the whole document. See lib/shadow.mjs for the measurement that forced it.
 */
const COLLECT_RECTS = (band) => {
    const deep = window.__auditDeep;
    const elements = deep ? deep.all(document.body) : document.querySelectorAll('body *');
    const above = deep ? deep.parent : (el) => el.parentElement;
    const out = [];

    // TWO ANCESTOR CONDITIONS, ONE WALK, because they ask about the same chain.
    //
    // `clipped`: fully clipped by an ancestor's overflow — an off-screen carousel slide,
    // a collapsed accordion panel with height:0 on the wrapper. The element itself
    // reports a perfectly normal rect, so only walking up catches it.
    //
    // `transparent`: inside an ancestor whose computed opacity is 0. This walk did not
    // exist, and it is why 89 elements of boondmanager.com's solutions slider were
    // recorded as ordinary visible content: the container is `opacity: 0` and every child
    // reports `opacity: 1` for itself. They are NOT dropped — a dropped element is
    // indistinguishable from a page that genuinely has nothing there, which is the answer
    // this tool must never give wrongly — they are recorded and flagged, so that
    // "transparent when we looked" and "should have painted and did not" stop being the
    // same fact. See lib/painted.mjs, which is where the difference is spent.
    const ancestry = (el, r) => {
        let transparent = false;
        for (let a = above(el); a && a !== document.documentElement; a = above(a)) {
            const cs = getComputedStyle(a);
            if (cs.opacity === '0') transparent = true;
            if (a !== document.body
                && !(cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible')) {
                const ar = a.getBoundingClientRect();
                if (r.right <= ar.left || r.left >= ar.right || r.bottom <= ar.top || r.top >= ar.bottom) {
                    // Dropped anyway, so nothing above it needs asking.
                    return {clipped: true, transparent};
                }
            }
        }

        return {clipped: false, transparent};
    };

    // Does this element draw its own box? A card is a box; the section it sits in is
    // not, even though the section also has a background — what makes the card a module
    // is that its background DIFFERS from its parent's, or that it has a border or a
    // radius of its own. Comparing against the parent is the whole trick: without it,
    // every sectioned page reads as one enormous container.
    const boxed = (el, cs) => {
        const own = cs.backgroundColor;
        const parent = above(el) ? getComputedStyle(above(el)).backgroundColor : '';
        const transparent = (c) => !c || c === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(c);
        if (!transparent(own) && own !== parent) return true;
        if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) return true;

        return parseFloat(cs.borderTopLeftRadius) > 0;
    };

    for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const top = r.y + window.scrollY;
        if (band && (top + r.height <= band.top || top >= band.bottom)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const {clipped, transparent} = ancestry(el, r);
        if (clipped) continue;
        const rect = {
            x: Math.round(r.x + window.scrollX),
            y: Math.round(top),
            w: Math.round(r.width),
            h: Math.round(r.height),
            tag: el.tagName.toLowerCase(),
            // Only the raw signal. Deciding WHICH boxes are modules means comparing them
            // against each other, which belongs in segmentation where it is testable.
            // Deciding it here meant guessing a pixel floor for "contains another box",
            // and a 48px avatar inside a testimonial card was enough to disqualify the
            // card — the exact module the cut was supposed to protect.
            boxed: boxed(el, cs),
            text: (el.textContent || '').trim().slice(0, 200),
        };
        // Written only when true, the way `boxed` is read: absent means false everywhere
        // that consumes this file, and a flag on every rect of every page costs a line
        // each in a file that is already tens of thousands of them.
        if (transparent) rect.transparentAncestor = true;
        out.push(rect);
    }

    return out;
};

/** A rect's identity for the purpose of merging one slice's census into another's. */
const rectKey = (r) => `${r.tag}|${r.x}|${r.y}|${r.w}|${r.h}`;

/**
 * One census from the per-slice ones.
 *
 * NESTING IS NOT UNWOUND ANYWHERE IN THIS TOOL — an element's text includes its
 * descendants', a wrapper and the paragraph inside it both count, and lib/painted.mjs's
 * thresholds were measured against that definition. So a duplicate WITHIN a slice is
 * kept, and only duplication ACROSS slices is removed: each key keeps as many copies as
 * the single slice that saw the most of it. Two nested divs of identical size still
 * contribute two rects; the header that band 0 and band 1 both saw contributes one.
 *
 * AN ELEMENT AT TWO DIFFERENT COORDINATES IN TWO SLICES KEEPS BOTH, because on a page
 * like tpagency.com that is not an error — it is one element being moved, and the two
 * positions are two different rows of the image. Each band only ever offers rects it saw
 * while its own rows were on screen, so the position kept for a row is the one that row
 * was photographed with.
 *
 * Insertion order is the order of first sight, which makes the union deterministic and
 * keeps it close to document order within each band.
 */
export function unionRects(perSlice) {
    const best = new Map();
    for (const slice of perSlice) {
        const seen = new Map();
        for (const rect of slice) {
            const key = rectKey(rect);
            const list = seen.get(key);
            if (list) list.push(rect);
            else seen.set(key, [rect]);
        }
        for (const [key, list] of seen) {
            const held = best.get(key);
            if (!held || list.length > held.length) best.set(key, list);
        }
    }

    return [...best.values()].flat();
}

/**
 * Where a shot taken at scroll offset `at` belongs in the stitched image, or null when it
 * adds nothing to it.
 *
 * THE LAST SLICE IS THE REASON THIS IS A FUNCTION. A page is almost never an exact
 * multiple of the viewport, so the browser clamps the final scroll and the final shot
 * overlaps the one before it — on a 1296px page the last shot is of rows 396–1296, of
 * which 396–900 are already written. The overlap is CROPPED rather than composited over
 * the top: painting a band twice is a second rendering of the same rows and a second
 * chance for them to differ.
 */
export function slicePlacement(at, written, pageHeight, viewportHeight) {
    const bottom = Math.min(at + viewportHeight, pageHeight);
    if (bottom <= written) {
        return null;
    }

    return {top: written, skip: Math.max(0, written - at), height: bottom - written};
}

/**
 * The slices, composited into one full-height PNG.
 *
 * `parts` are `{buffer, top, skip, height}` as `slicePlacement` describes them. A part
 * that needs no crop is passed through as the bytes that came out of the browser, so the
 * common case re-encodes nothing.
 */
export async function stitchSlices(parts, width, height) {
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('there are no slices to stitch');
    }

    const composites = [];
    for (const part of parts) {
        const shot = await sharp(part.buffer).metadata();
        const cropped = part.skip > 0 || part.height !== shot.height;
        composites.push({
            input: cropped
                ? await sharp(part.buffer)
                    .extract({left: 0, top: part.skip, width: Math.min(width, shot.width), height: part.height})
                    .png()
                    .toBuffer()
                : part.buffer,
            top: part.top,
            left: 0,
        });
    }

    // White, because that is what an unpainted page is in Chromium — and because a canvas
    // row no slice covered should be glaringly visible in debug.png rather than blending
    // into a dark page as if it had been measured.
    return sharp({create: {width, height, channels: 3, background: {r: 255, g: 255, b: 255}}})
        .composite(composites)
        .png()
        .toBuffer();
}

/**
 * Photograph the page a viewport at a time, censusing each band beside its own shot, and
 * stitch the result into one image.
 *
 * THE HEIGHT IS DECIDED ONCE, before the first slice, and never revisited: a page that
 * grows while it is being photographed would otherwise move every offset underneath the
 * pass and produce an image no single state of the page ever had. What the growth costs
 * instead is that the stitched image is a prefix of the taller page — which is exactly
 * what `shotTruncationWarning` already says out loud, because `meta.fullHeight` is
 * measured after the capture and the image's own height is recorded beside it.
 *
 * THE CENSUS IS BANDED TO THE ROWS THE SLICE CONTRIBUTES, not to its whole viewport. Each
 * row of the image is owned by exactly one shot, so crediting a rect to the band it was
 * seen in is what keeps the two records describing the same page: on a site that moves
 * content into place only while it is on screen, an element seen at two positions is one
 * element in two places, and the position that belongs to a row is the one that row was
 * photographed with.
 *
 * Nothing here is allowed to add variance of its own: the offsets are multiples of the
 * viewport, the settle is a fixed wait, the overlap is cropped rather than overpainted,
 * and the pass stops on a condition rather than a timer.
 */
export async function slicedScreenshot(page, opts) {
    const {width, height, viewportHeight, maxSlices, settleMs, step, chrome = [], decided = new Set()} = opts;

    const parts = [];
    const census = [];
    // WHAT ARRIVED AFTER THE DECISION WAS MADE. The pinned census runs once, before the
    // slicing, so an element that appears later — boondmanager.com's consent card is loaded
    // by a tag manager partway down the page — is in no population and is judged by nothing.
    // It is counted here rather than left silent: a repeat this pass could not judge is a
    // fact about the image, and the alternative is a capture that quietly contains one.
    const late = newCensus();
    const lateArrivals = new Set();
    let written = 0;
    let hidden = 0;
    let stoppedEarly = null;
    try {
        for (let i = 0; i < maxSlices && written < height; i++) {
            const at = await step(`scrolling to slice ${i}`, () => page.evaluate((target) => {
                window.scrollTo(0, target);

                return Math.round(window.scrollY);
            }, i * viewportHeight));
            // The pass has been overtaken by the page — the scroll went FURTHER than the
            // rows already written, so the band between them was never photographed.
            // Stopping leaves a short image, which the height comparison declares;
            // carrying on would leave a hole in the middle of a full-height one.
            if (at > written) {
                stoppedEarly = `the page scrolled to y=${at} with only ${written}px photographed`;
                break;
            }
            await page.waitForTimeout(settleMs);
            for (const id of recordStep(late, await step(
                `looking for anything new that holds its place at slice ${i}`,
                () => page.evaluate(MEASURE_BOXES),
            ))) {
                if (!decided.has(id)) lateArrivals.add(id);
            }
            // Never in the first slice: at scroll 0 a pinned element is where the page
            // meant it to be, and that is the one sighting of it the image should keep.
            if (i > 0 && chrome.length) {
                // The COUNT IS KEPT, not thrown away: "we asked for six elements to be
                // hidden and six were" is the only thing that separates a page with no
                // repeating chrome from one whose chrome the pass failed to reach.
                hidden = await step(
                    `hiding repeating chrome for slice ${i}`,
                    () => page.evaluate(HIDE_PINNED, chrome),
                );
            }
            const place = slicePlacement(at, written, height, viewportHeight);
            if (!place) {
                stoppedEarly = `the page stopped scrolling at y=${at} with ${written}px of ${height}px photographed`;
                break;
            }
            const buffer = await step(`photographing slice ${i}`, () => page.screenshot());
            // ASSERTED AGAIN BEFORE THE CENSUS, because the two records have to describe
            // the same page. A site's own script can put an inline style back between the
            // shot and the walk — switch.je does — and the census would then list a footer
            // the image does not contain.
            if (i > 0 && chrome.length) {
                await step(
                    `holding chrome hidden for the census of slice ${i}`,
                    () => page.evaluate(HIDE_PINNED, chrome),
                );
            }
            const band = {top: place.top, bottom: place.top + place.height};
            census.push(await step(`censusing slice ${i}`, () => page.evaluate(COLLECT_RECTS, band)));
            parts.push({buffer, ...place});
            written = place.top + place.height;
        }
    } finally {
        // ON ITS OWN SHORT DEADLINE, not the capture's. This runs on the way out of a
        // failure as well as a success, and the failure it most often follows is a page
        // that stopped answering — which is exactly the page that would hang here and undo
        // the whole point of having a budget.
        await withDeadline(page.evaluate(RESTORE_HIDDEN), CLEANUP_MS, 'putting hidden elements back')
            .catch(() => {});
    }

    return {
        png: await stitchSlices(parts, width, written),
        rects: unionRects(census),
        slices: parts.length,
        height: written,
        hidden,
        lateArrivals: lateArrivals.size,
        stoppedEarly,
    };
}

export async function capturePage(url, outDir, opts = {}) {
    const maxScrolls = opts.maxScrolls ?? 40;
    const settleMs = opts.sliceSettleMs ?? SLICE_SETTLE_MS;
    const clock = budget(opts.budgetMs ?? CAPTURE_BUDGET_MS);
    mkdirSync(outDir, {recursive: true});

    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        // WHAT THIS PAGE SHIPS, counted on the load we are doing anyway. Attached before
        // the first navigation so nothing is missed, and it costs the capture nothing: no
        // key, no second page load, no service that can be down. PageSpeed reports a byte
        // weight too and it is not this one — Lighthouse never scrolls, so everything
        // lazy-loaded is absent from it. See lib/bytes.mjs.
        //
        // A FAILURE HERE IS NEVER THE CAPTURE'S. A byte count is the least important thing
        // this tool produces and the capture is the most expensive, so the census declares
        // itself unmeasured rather than throwing into a run that is otherwise fine.
        let bytes = null;
        try {
            bytes = await countBytes(await context.newCDPSession(page));
        } catch (e) {
            process.stderr.write(`byte census unavailable: ${printable(e.message, 200)}\n`);
        }
        // EVERY IN-PAGE STEP IS BOUNDED. Playwright puts no timeout on evaluate or on
        // screenshot, and a page that never returned from one of them held a capture for
        // fourteen minutes. The budget is the whole capture's, so a single stuck step
        // spends what is left of it and then fails like the 403 does: exit 1, a clear
        // message, no artefacts.
        const step = (what, start) => withDeadline(start(), clock.check(what), what);
        // Before the page's own scripts, so a hero that asks for a context on first
        // evaluation is still recorded.
        await page.addInitScript(WEBGL_PROBE_INIT);
        // In EVERY frame, and before the page builds its components: every walk this
        // capture takes calls it, including the consent finder inside a CMP's iframe.
        await page.addInitScript(SHADOW_INIT);
        // THE STATUS WAS THROWN AWAY, and a blocked request looks exactly like a page.
        // webreality.co.uk answers a headless browser with a CloudFront 403: the capture
        // succeeded, wrote its artefacts, segmented into two blocks with area conserved
        // and exited 0. A prospect whose CDN blocks the crawler would have been emailed
        // confident percentages of an error page, which is the worst shape this tool has
        // — every other blind spot at least declares itself.
        //
        // `goto` returns null for a same-document navigation, where there is no response
        // to read. That is not a failure and must not be reported as one.
        const response = await page.goto(url, {
            waitUntil: 'load',
            timeout: Math.min(45000, clock.check('the page to load')),
        });
        const httpStatus = response ? response.status() : null;
        await page.waitForLoadState('networkidle', {
            timeout: Math.min(20000, clock.check('the network to go quiet')),
        }).catch(() => {});

        // WHERE THE SITE ITSELF PUT US, read before we have touched anything. A capture
        // ending on a different URL is two entirely different events wearing one face: the
        // site redirected us, or one of our own clicks carried the page away. dept.agency
        // is the first: it is a rebranded company and answers with dept.global, which IS
        // its homepage and is the right thing to measure. Without this line the only
        // record was the final URL, so both events read as `wrongPage` — "these blocks are
        // of another site" — about a perfectly correct measurement. See lib/notes.mjs.
        const landedUrl = page.url();
        // Before the scroll pass, so the gap between this and the end is what deferring
        // work actually bought. kohde.agency: 1,229 KiB here, 2,710 KiB by the end.
        bytes?.mark('atLoad');

        // SMOOTH SCROLLING IS A SOURCE OF VARIANCE, and this pass scrolls a great deal. A
        // page with `scroll-behavior: smooth` animates every scrollTo below, so a shot can
        // land part way through one. Not fatal if the page refuses the style — a CSP can —
        // but worth having wherever it is allowed.
        await page.addStyleTag({content: 'html,body{scroll-behavior:auto !important}'}).catch(() => {});

        // REFUSED RATHER THAN DEGRADED. Without this walk every census below silently skips
        // whatever a page builds inside a web component, and the capture looks exactly the
        // same: fewer rects, no error, no flag. A number that quietly stops counting part of
        // the page is the one failure this tool is not allowed to have.
        if (!(await step('checking the shadow-DOM walk', () => page.evaluate(SHADOW_CENSUS))).installed) {
            throw new Error('the shadow-DOM walk was not installed, so every census would miss this page\'s components');
        }

        await step('opening the pinned census', () => page.evaluate(BEGIN_PIN));
        // BEFORE THE BANNER IS DISMISSED, because afterwards the banner is gone and the
        // question of whether it held the viewport cannot be asked at all. See
        // markEarlyPinned — this only ever widens what lib/consent.mjs will consider.
        //
        // EVERY PART OF THE PINNED WORK IS TIMED, because it is paid on every capture and a
        // cost nobody can see is a cost nobody can argue with.
        const startedEarly = Date.now();
        const earlyPinned = await markEarlyPinned(page, {step, settleMs: EARLY_SETTLE_MS});
        const earlyMs = Date.now() - startedEarly;

        const startedConsent = Date.now();
        const atLoad = await step('dismissing a consent banner', () => dismissConsent(page));
        const atLoadConsentMs = Date.now() - startedConsent;

        // Step down a viewport at a time so lazy images and in-view animations fire — AND
        // MEASURE EVERY ELEMENT'S VIEWPORT BOX AT EACH STEP. The pass already stops and
        // settles at every viewport, so the pinned census rides along on it for the cost of
        // one bounding-box walk per step (74–463ms for a whole page, measured across six
        // sites) rather than a second traverse of its own.
        const census = newCensus();
        let censusMs = 0;
        let scrolls = 0;
        let previousHeight = -1;
        for (; scrolls < maxScrolls; scrolls++) {
            const startedCensus = Date.now();
            const measured = await step('measuring what holds its place', () => page.evaluate(MEASURE_BOXES));
            const pinned = recordStep(census, measured);
            if (pinned.length) {
                census.marked += await step('marking what held its place', () => page.evaluate(MARK_PINNED, pinned));
            }
            censusMs += Date.now() - startedCensus;
            const height = await step('measuring the page height', () => page.evaluate(PAGE_HEIGHT));
            const atBottom = await step('checking for the bottom of the page', () => page.evaluate(
                (h) => window.scrollY + window.innerHeight >= h - 2,
                height,
            ));
            if (atBottom && height === previousHeight) break;
            previousHeight = height;
            await step('scrolling down a viewport', () => page.evaluate(() => window.scrollBy(0, window.innerHeight)));
            await page.waitForTimeout(400);
        }
        const scrollCapHit = scrolls >= maxScrolls;
        // The page has now been walked from top to bottom, which is what makes this the
        // weight a visitor who read the page would have paid.
        bytes?.mark('afterScroll');

        // ONE MORE ATTEMPT AT A BANNER THAT WAS NOT THERE WHEN WE ASKED, and this is the
        // moment for it: the page has been scrolled to the bottom, so a banner loaded by a
        // tag manager has certainly arrived, and nothing has been photographed yet. See
        // dismissLateConsent — it costs one FIND_BANNER per frame on a page with nothing to
        // do, and it never runs at all if the first attempt already saw a banner.
        const startedLate = Date.now();
        const consent = await step('looking again for a consent banner', () => dismissLateConsent(page, atLoad));
        const lateConsentMs = Date.now() - startedLate;

        // AT THE BOTTOM, before scrolling back: a reveal footer is only in its resting
        // place once the content has travelled over it.
        const fixed = await step('collecting pinned elements', () => page.evaluate(COLLECT_PINNED));
        // Beside it, and from the same place: how much of this page is behind a component
        // boundary. "This page has no web components" and "the walk stopped working" are
        // then different numbers rather than the same silence.
        const shadow = await step('counting web components', () => page.evaluate(SHADOW_CENSUS));

        // WHICH OF THEM REPEAT, decided on their own pixels rather than on `position`.
        const startedDecision = Date.now();
        const decided = await decideChrome(page, census, {
            step,
            settleMs,
            viewport: VIEWPORT,
            shoot: () => page.screenshot(),
            raw: async (buffer) => (await sharp(buffer).removeAlpha().raw().toBuffer({resolveWithObject: true})).data,
        });
        const decideMs = Date.now() - startedDecision;

        await step('scrolling back to the top', () => page.evaluate(() => window.scrollTo(0, 0)));
        await page.waitForTimeout(400);

        await step('photographing the viewport', () => page.screenshot({path: join(outDir, 'viewport.png')}));

        // The height the slicing is planned against, taken once and at the top. See
        // slicedScreenshot for what a page that grows after this costs.
        const plannedHeight = await step('measuring the page for slicing', () => page.evaluate(PAGE_HEIGHT));
        const pageWidth = await step('measuring the page width', () => page.evaluate(PAGE_WIDTH));
        // No further than the scroll pass above was willing to go: content below the
        // fortieth viewport was never given the chance to load, so photographing it would
        // be photographing a region this capture never woke up. `scrollCapHit` already
        // declares that the page ran past the end of the pass.
        const maxSlices = opts.maxSlices ?? maxScrolls + 1;

        let shot;
        let rects = null;
        const capture = {
            mode: 'stitched',
            slices: 0,
            viewportHeight: VIEWPORT.height,
            plannedHeight,
            pageWidth,
            rects: 0,
            rectsAtTop: 0,
            stoppedEarly: null,
            fallbackReason: null,
            pinned: {earlyPinned, ...decided.record, hidden: 0, lateArrivals: 0, earlyMs, censusMs, decideMs},
            // How much of the page is behind a component boundary, and what each consent
            // attempt cost in wall clock. Both are paid on every capture, and a cost nobody
            // can see is a cost nobody can argue with.
            shadow,
            consentMs: {atLoad: atLoadConsentMs, late: lateConsentMs},
        };
        try {
            const sliced = await slicedScreenshot(page, {
                width: VIEWPORT.width,
                height: plannedHeight,
                viewportHeight: VIEWPORT.height,
                maxSlices,
                settleMs,
                step,
                chrome: decided.chrome,
                decided: new Set(census.pinnedAt.keys()),
            });
            shot = sliced.png;
            rects = sliced.rects;
            capture.slices = sliced.slices;
            capture.pinned.hidden = sliced.hidden;
            capture.pinned.lateArrivals = sliced.lateArrivals;
            capture.stoppedEarly = sliced.stoppedEarly;
        } catch (e) {
            // THE OLD BEHAVIOUR IS STILL AVAILABLE, and it is a reasonable image; it is
            // simply the one taken from the top, with everything that costs. Recorded in
            // meta so the difference is visible to everything downstream rather than being
            // a silently worse capture that looks identical.
            capture.mode = 'fullpage';
            capture.fallbackReason = e.message;
            await withDeadline(
                page.evaluate(() => window.scrollTo(0, 0)),
                CLEANUP_MS,
                'getting back to the top for the fallback shot',
            ).catch(() => {});
            await page.waitForTimeout(400);
            shot = await step('photographing the whole page in one shot', () => page.screenshot({fullPage: true}));
        }
        writeFileSync(join(outDir, 'fullpage.png'), shot);

        // BACK TO THE TOP BEFORE ANYTHING ELSE IS MEASURED, because that is the coordinate
        // space every consumer of rects.json assumes: a `position: fixed` element reports
        // its viewport box, and measuring at the bottom of the slice pass would place all
        // of them a page-height away from where the image has them.
        await step('scrolling back to the top', () => page.evaluate(() => window.scrollTo(0, 0)));
        await page.waitForTimeout(400);

        // THE CENSUS THE OLD CAPTURE WOULD HAVE TAKEN, kept as a number rather than a
        // list. It is what makes the banded census's gain visible per page instead of
        // being a claim in a commit message — and on the fallback path it is the census.
        const topRects = await step('collecting DOM rects', () => page.evaluate(COLLECT_RECTS, null));
        capture.rectsAtTop = topRects.length;
        if (!rects) rects = topRects;
        capture.rects = rects.length;

        const fullHeight = await step('measuring the final page height', () => page.evaluate(PAGE_HEIGHT));
        const image = pngSize(shot);
        const webgl = await step('probing WebGL', () => probeWebgl(page));

        const meta = {
            url,
            // THE PAGE WE ACTUALLY MEASURED, which is not always the one we asked for: a
            // site can redirect, and a click during consent dismissal used to be able to
            // walk the capture onto another page entirely with nothing recording it.
            // Kept separate from `url` so the two can be compared rather than conflated.
            capturedUrl: page.url(),
            landedUrl,
            capturedAt: new Date().toISOString(),
            viewport: VIEWPORT,
            fullHeight,
            image,
            capture,
            // What the page shipped, over the load and the scroll that produced the image
            // above. Never PageSpeed's number — see lib/bytes.mjs for why they differ and
            // why two page weights in one report is worse than one.
            bytes: bytes ? bytes.result() : {measured: false, why: 'the census never attached'},
            httpStatus,
            consentDismissed: consent.dismissed,
            consentBannerSeen: consent.bannerSeen === true,
            consentVia: consent.via,
            consentNavigatedAway: consent.navigatedAway === true,
            // THE BANNER WAS NOT THERE WHEN THE PAGE LOADED. It arrived during the scroll
            // pass, so every measurement taken before that point was of a page without it.
            consentArrivedLate: consent.arrivedLate === true,
            scrollCapHit,
            webgl,
            fixed,
            heightGap: heightGap(fullHeight, rects, fixed),
        };
        writeFileSync(join(outDir, 'rects.json'), JSON.stringify(rects, null, 1));
        writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));

        return meta;
    } finally {
        await browser.close();
    }
}
