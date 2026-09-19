/**
 * CANDIDATES
 *
 * The coordinates a block boundary is allowed to land on: the edges of elements the page
 * actually drew.
 *
 *   node --test tools/audit/test/candidates.test.mjs
 *
 * A vision model places a boundary to within ten or twenty pixels — measured across three
 * runs of the same image — and rects.json says where elements ACTUALLY stop, exactly.
 * Snapping one to the other is what turns an approximate answer into a reproducible
 * number: on andybudd.com two runs whose raw boundaries differed reached 8 of 8 identical
 * after snapping, and 0.0px of drift.
 *
 * These three lived in lib/xycut.mjs, where they were the snap targets for an XY-cut. They
 * were moved out before that file was retired because they are not part of the cutting:
 * they answer "where does an element stop", which is a fact about the page and outlives
 * whatever decides where the blocks are.
 *
 * The limitation worth knowing: snapping cannot rescue a boundary the model genuinely
 * placed somewhere else. kohde.agency returns 10 blocks on one run and 11 on the next,
 * because it sometimes reads two sections as one; no amount of snapping makes those two
 * answers agree. That is why a page is audited once — see lib/signature.mjs.
 */

/**
 * A rect worth snapping to: an element that carries content, not the page scaffolding
 * around it. Page-level wrappers span the whole document, so their edges coincide with
 * the page's own extremes — left in, they are by far the most numerous candidates near
 * any boundary and they mark nothing. Hairlines and icons are excluded for the opposite
 * reason: too many of them, too small to be a section break.
 */
export const CONTENT_RECT = {maxH: 700, minW: 60, minH: 12};

export function isContentRect(r) {
    return r.h < CONTENT_RECT.maxH && r.w >= CONTENT_RECT.minW && r.h >= CONTENT_RECT.minH;
}

/**
 * Candidate coordinates on one axis: every content rect's leading and trailing edge,
 * sorted ascending and de-duplicated.
 *
 * Sorted is not cosmetic. A caller scanning in order and keeping the first of an equal
 * pair resolves a tie to the smaller coordinate no matter what order rects.json happened
 * to list its elements in.
 */
export function edgeCandidates(rects, horizontal) {
    if (!rects || rects.length === 0) return [];

    const seen = new Set();
    for (const r of rects) {
        if (!isContentRect(r)) continue;
        if (horizontal) {
            seen.add(r.y);
            seen.add(r.y + r.h);
        } else {
            seen.add(r.x);
            seen.add(r.x + r.w);
        }
    }

    return [...seen].sort((a, b) => a - b);
}
