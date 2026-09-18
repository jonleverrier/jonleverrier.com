/**
 * UNRENDERED
 *
 * Parts of the page that exist for a visitor and are missing from this capture.
 *
 *   node --test tools/audit/test/unrendered.test.mjs
 *
 * WHY: a full-page screenshot does not paint `position: fixed` elements down the page,
 * and DOM rects are collected at scroll-top where a fixed element reports its viewport
 * box rather than where a visitor sees it. A site using a fixed "reveal" footer — the
 * content scrolling up over it — therefore lands in the capture as nothing at all.
 *
 * switch.je is the case that found this. Its footer is `position: fixed`, visible, 745px
 * tall at y=4086. The page reports a scrollHeight of 4831; the deepest element in
 * rects.json ends at 4088; and the pixels from 4088 down measure a flat fill with a
 * standard deviation of 0.0. Both halves of the capture miss it, so 15% of that page
 * would be reported as empty structural whitespace when it is a whole footer.
 *
 * THE POINT IS NOT TO INVENT THE MISSING PIXELS. Writing a rect for something the
 * screenshot does not contain would be worse than the gap: cuts would snap to boundaries
 * invisible in the image, and phase 3 would be asked to classify a blank rectangle. The
 * point is to know, and to say, that a region is unmeasured rather than empty — a
 * distinction that matters because deliberate whitespace is a real design choice and
 * should be reported as such, while this is simply a hole in our data.
 *
 * The detection is deliberately cause-agnostic: the page claims more height than its
 * content accounts for. That catches fixed footers, reveal panels and sticky overlays
 * without special-casing any of them. `fixed` is collected alongside only to NAME the
 * likely cause in the warning.
 *
 * The limitation worth knowing: a page with a genuine run of empty space at its foot —
 * a deliberate one — trips this too. It is a flag for a human, not a verdict, and it
 * says "unmeasured", never "wrong".
 *
 * A second, cheaper check lives here for the same reason: the screenshot's own height
 * against the page's. See shotTruncationWarning.
 */

import {printable} from './printable.mjs';

/** Ignore slivers: a gap this small is a rounding artefact, not a missing region. */
export const GAP_MIN_PX = 100;

/** …and it has to be worth mentioning relative to the page. */
export const GAP_MIN_FRACTION = 0.02;

/** A fixed element smaller than this is furniture — a cookie bar, a back-to-top chip. */
export const FIXED_MIN_AREA = 40000;

/**
 * Collect the elements that hold the viewport, in page coordinates. Runs IN the page.
 *
 * Call this AT THE BOTTOM OF THE SCROLL, not at the top: a reveal footer is only in its
 * resting place once the content has travelled over it.
 *
 * THIS USED TO ASK `position: fixed` AND ONLY THAT, and it missed the case it most needed
 * to catch. boondmanager.com's consent card computes `position: relative` and is held in
 * the viewport by script, so it painted twelve times down the capture and appeared in no
 * record of anything. What is collected now is the BEHAVIOURAL population — whatever
 * lib/pinned.mjs measured as holding its viewport box while the page scrolled under it —
 * with `position: fixed` kept beside it rather than instead of it, because a capture that
 * never ran the census (the single-shot fallback path) would otherwise report nothing at
 * all here and `heightGap` would lose the ability to name switch.je's reveal footer.
 * `via` says which of the two found it.
 *
 * OUTERMOST ONLY. A pinned nav has a hundred pinned descendants and listing them all would
 * bury the one element a reader of meta.json wants to see; hiding the outermost takes the
 * rest with it anyway.
 */
export const COLLECT_PINNED = () => {
    const held = (el) => el.__auditPinned === true || getComputedStyle(el).position === 'fixed';
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        const pinned = el.__auditPinned === true;
        const fixed = cs.position === 'fixed';
        if (!pinned && !fixed) continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        let outermost = true;
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            if (held(a)) {
                outermost = false;
                break;
            }
        }
        if (!outermost) continue;
        out.push({
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            tag: el.tagName.toLowerCase(),
            via: pinned && fixed ? 'both' : (pinned ? 'pinned' : 'fixed'),
        });
    }

    return out;
};

/** The deepest point any captured element reaches. 0 when there is nothing. */
export function contentBottom(rects) {
    if (!Array.isArray(rects) || rects.length === 0) {
        return 0;
    }

    return rects.reduce((deepest, r) => Math.max(deepest, r.y + r.h), 0);
}

/**
 * How much of the page's height its captured content fails to account for.
 *
 * `significant` is the judgement: big enough in absolute pixels AND as a share of the
 * page. A 120px gap on a 12,000px page is noise; the same gap on an 800px page is not.
 */
export function heightGap(fullHeight, rects, fixed = []) {
    const bottom = contentBottom(rects);
    const gap = Math.max(0, fullHeight - bottom);
    const fraction = fullHeight > 0 ? gap / fullHeight : 0;
    const significant = gap >= GAP_MIN_PX && fraction >= GAP_MIN_FRACTION;

    // Which pinned element, if any, sits in the unexplained band — ranked by how much of
    // THAT BAND it covers, not by how big it is. Raw size names a scroll-to-top button
    // never, which is right, but it also names the wrong large thing: switch.je carries a
    // full-viewport fullscreen-menu overlay of 1440x900 pinned at the top of the viewport
    // AND the 1440x745 reveal footer this file was written for, and by area alone the menu
    // wins. Both cover the whole gap, so the tie goes to the one that begins where the
    // content stopped — which is the footer, 2px below `contentBottom` against the menu's
    // 157px above it.
    const covered = (f) => f.w * Math.max(0, Math.min(f.y + f.h, fullHeight) - Math.max(f.y, bottom));
    const suspects = (fixed ?? [])
        .filter((f) => f.w * f.h >= FIXED_MIN_AREA && f.y + f.h > bottom)
        .sort((a, b) => covered(b) - covered(a)
            || Math.abs(a.y - bottom) - Math.abs(b.y - bottom)
            || b.w * b.h - a.w * a.h);

    return {
        contentBottom: bottom,
        gap,
        fraction: Number(fraction.toFixed(4)),
        significant,
        likelyCause: suspects.length ? suspects[0] : null,
    };
}

/**
 * The page height and the screenshot's height disagree by more than rounding.
 *
 * `scrollHeight` is an integer rounding of a fractional layout height, so the shot may
 * legitimately be a pixel short; more than that means the screenshot stopped early —
 * Chromium has a limit, and a page can also grow between the measure and the shot.
 */
export const SHOT_SLACK_PX = 1;

/**
 * One line for a human when the image is not the whole page, or null.
 *
 * This matters because PHASE 2 MEASURES THE IMAGE. Every percentage it produces is over
 * the PNG's area, so a truncated screenshot yields confident percentages of a prefix of
 * the page with nothing declaring it — and once the browser has closed there is no way
 * to notice. Comparing the two numbers is the whole check.
 */
/**
 * The height above which Chromium stops painting a full-page screenshot.
 *
 * It still WRITES the full height — the PNG is the right size and the rows below are
 * background — which is why comparing the two heights cannot see this. Only the page's
 * own height against the limit can.
 */
export const PAINT_LIMIT_PX = 16384;

/**
 * One line when the page is taller than Chromium will paint IN ONE SHOT, or null.
 *
 * visionarygrid.studio is 24,746px. A single full-page screenshot wrote a 24,746px PNG
 * whose content stopped dead at y=16382, so 8,364px — 34% of the page — was white
 * background with the DOM rects for real content sitting underneath it. Nothing in that
 * run looked wrong: the two heights agreed, the scroll cap was not hit, and
 * `contentBottom` equalled `fullHeight`.
 *
 * A STITCHED CAPTURE DOES NOT HAVE THIS PROBLEM AND MUST NOT CLAIM TO. Every slice is a
 * viewport shot, far below any texture limit, so the painting ceiling never applies —
 * verified on that page at y=16000, 18000, 22000 and 24000, all of which photograph real
 * content. `meta.capture.mode` says which path ran, and this warning is for the one that
 * still can be truncated. A stitched image that came up short says so through its own
 * height instead; see shotTruncationWarning.
 *
 * What remains true for a page this tall is that PHASE 2 declines to segment the image —
 * MAX_IMAGE_HEIGHT in lib/edges.mjs is a memory budget, not a painting limit, and it is a
 * separate refusal with a separate reason.
 */
export function paintLimitWarning(meta) {
    const pageHeight = meta?.fullHeight;
    if (!(pageHeight > PAINT_LIMIT_PX)) {
        return null;
    }
    if (meta?.capture?.mode === 'stitched') {
        return null;
    }
    const missing = pageHeight - PAINT_LIMIT_PX;
    const pct = ((missing / pageHeight) * 100).toFixed(1);

    return `the page is ${pageHeight}px tall and Chromium stops painting at ${PAINT_LIMIT_PX}px, so the `
        + `bottom ${missing}px (${pct}% of it) is blank background in the screenshot rather than `
        + 'content. Phase 2 refuses an image this tall rather than measure that emptiness';
}

export function shotTruncationWarning(meta) {
    const pageHeight = meta?.fullHeight;
    const imageHeight = meta?.image?.height;
    if (!(pageHeight > 0) || !(imageHeight > 0)) {
        return null;
    }
    if (imageHeight + SHOT_SLACK_PX >= pageHeight) {
        return null;
    }

    const missing = pageHeight - imageHeight;

    return `the screenshot is ${imageHeight}px tall but the page measures ${pageHeight}px, so `
        + `${missing}px was never captured. Percentages from this run are of the top `
        + `${imageHeight}px only, not of the page`;
}

/** One line for a human, or null when there is nothing worth saying. */
export function unrenderedWarning(meta) {
    const g = meta?.heightGap;
    if (!g?.significant) {
        return null;
    }

    const pct = (g.fraction * 100).toFixed(1);
    // The tag is the page's, by way of rects.json, and this line goes to a terminal.
    const cause = g.likelyCause
        ? ` — a pinned <${printable(g.likelyCause.tag, 40)}> of ${g.likelyCause.w}x${g.likelyCause.h} sits there,`
            + ' and an element that holds the viewport is kept at its first sighting rather than'
            + ' painted again at every scroll offset'
        : '';

    return `${g.gap}px (${pct}% of the page) is below the deepest element captured${cause}`
        + '. Treat that region as unmeasured, not as empty space';
}
