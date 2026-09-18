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
 */

/** Ignore slivers: a gap this small is a rounding artefact, not a missing region. */
export const GAP_MIN_PX = 100;

/** …and it has to be worth mentioning relative to the page. */
export const GAP_MIN_FRACTION = 0.02;

/** A fixed element smaller than this is furniture — a cookie bar, a back-to-top chip. */
export const FIXED_MIN_AREA = 40000;

/**
 * Collect `position: fixed` elements, in page coordinates. Runs IN the page.
 *
 * Call this AT THE BOTTOM OF THE SCROLL, not at the top: a reveal footer is only in its
 * resting place once the content has travelled over it.
 */
export const COLLECT_FIXED = () => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            tag: el.tagName.toLowerCase(),
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

    // Which fixed element, if any, sits in the unexplained band. Largest first so the
    // warning names the footer rather than a scroll-to-top button that happens to be
    // down there too.
    const suspects = (fixed ?? [])
        .filter((f) => f.w * f.h >= FIXED_MIN_AREA && f.y + f.h > bottom)
        .sort((a, b) => b.w * b.h - a.w * a.h);

    return {
        contentBottom: bottom,
        gap,
        fraction: Number(fraction.toFixed(4)),
        significant,
        likelyCause: suspects.length ? suspects[0] : null,
    };
}

/** One line for a human, or null when there is nothing worth saying. */
export function unrenderedWarning(meta) {
    const g = meta?.heightGap;
    if (!g?.significant) {
        return null;
    }

    const pct = (g.fraction * 100).toFixed(1);
    const cause = g.likelyCause
        ? ` — a fixed <${g.likelyCause.tag}> of ${g.likelyCause.w}x${g.likelyCause.h} sits there and a`
            + ' full-page screenshot does not paint fixed elements down the page'
        : '';

    return `${g.gap}px (${pct}% of the page) is below the deepest element captured${cause}`
        + '. Treat that region as unmeasured, not as empty space';
}
