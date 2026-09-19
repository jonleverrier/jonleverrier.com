/**
 * OVERLAY
 *
 * Chrome that escaped every DOM rule, found in the pixels instead.
 *
 *   node --test tools/audit/test/overlay.test.mjs
 *
 * lib/pinned.mjs decides what holds the viewport by measuring elements, and hides the ones
 * that repeat. It can only decide elements it can REACH. natwest.com's "Chat to Cora"
 * widget is rendered by LivePerson into something the capture cannot see at all: not the
 * main frame's light DOM, not an open shadow root, and its two LivePerson iframes are 0x0.
 * The pinned census correctly reports zero pinned elements on that page, and the widget is
 * painted into all eight slices of the stitched image.
 *
 * WHATEVER IT IS AND WHEREVER IT LIVES, IT REPEATS. A pinned overlay is drawn at the same
 * viewport-relative position in every slice, so the same pixels appear at the same offset
 * within each one. That is visible from the image alone and needs no selector, no vendor
 * list, and no access to the element — which is what makes it the robust test rather than
 * a better guess at where the widget might be.
 *
 * IT IS DECLARED, NOT ERASED. The obvious next step is to paint the repeats out, and it is
 * wrong: what is behind an overlay was never captured, so filling it in would be inventing
 * pixels, which is the one thing this tool refuses to do. A region a persistent overlay
 * covers is UNMEASURED — the same answer given to a fixed reveal footer, a canvas that
 * never drew, and content behind a transparent ancestor. See lib/notes.mjs.
 *
 * The limitation worth knowing: a page whose every slice shares a genuinely identical
 * detailed region — a repeating background motif aligned exactly to the viewport height —
 * would be reported as an overlay. Nothing in the 26-site corpus does this, and the
 * detail gate below is what keeps plain margins and flat colour out.
 */
import sharp from 'sharp';

/** The grid the image is compared on. Small enough to locate a widget, coarse enough to be cheap. */
export const CELL = 40;

/** Mean channel difference below which two cells are "the same pixels". */
export const SAME_MAX = 2;

/** A cell flatter than this is background, not chrome, however well it agrees. */
export const DETAIL_MIN = 12;

/**
 * What share of the other slices must agree, and the floor beneath it.
 *
 * A FRACTION RATHER THAN A DISSENT COUNT, and that was measured the wrong way round first.
 * Allowing "up to two slices may disagree" means a four-slice page needs only ONE agreeing
 * slice, and hsbc.co.uk duly produced nineteen regions of noise. Requiring most of the
 * page to agree scales with how much evidence there actually is.
 */
export const AGREE_FRACTION = 0.8;
export const AGREE_MIN = 4;

/** …and a region this small is a coincidence, not a widget. */
export const MIN_CELLS = 4;

/** Mean absolute channel difference between two cells of the same image. */
export function cellDifference(px, width, ax, ay, bx, by, cell = CELL) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < cell; y += 2) {
        for (let x = 0; x < cell; x += 2) {
            const i = ((ay + y) * width + ax + x) * 3;
            const j = ((by + y) * width + bx + x) * 3;
            sum += Math.abs(px[i] - px[j]) + Math.abs(px[i + 1] - px[j + 1]) + Math.abs(px[i + 2] - px[j + 2]);
            n += 3;
        }
    }

    return n ? sum / n : 0;
}

/** How much a cell varies within itself. Flat colour scores 0. */
export function cellDetail(px, width, x0, y0, cell = CELL) {
    let min = 255;
    let max = 0;
    for (let y = 0; y < cell; y += 2) {
        for (let x = 0; x < cell; x += 2) {
            const i = ((y0 + y) * width + x0 + x) * 3;
            min = Math.min(min, px[i], px[i + 1], px[i + 2]);
            max = Math.max(max, px[i], px[i + 1], px[i + 2]);
        }
    }

    return max - min;
}

/**
 * The rectangles a persistent overlay occupies, in SLICE-RELATIVE coordinates.
 *
 * Slice-relative because that is what the thing actually is: one region of the viewport,
 * repeated. Where it lands on the page is every slice's offset plus this.
 */
export function overlayRegions(px, width, height, sliceHeight, opts = {}) {
    const {cell = CELL, sameMax = SAME_MAX, detailMin = DETAIL_MIN,
        agreeFraction = AGREE_FRACTION, agreeMin = AGREE_MIN, minCells = MIN_CELLS} = opts;
    const slices = Math.floor(height / sliceHeight);
    // Fewer than five slices cannot tell a repeat from a coincidence, and a short page has
    // little stitching artefact to find in the first place.
    if (slices < 5) {
        return [];
    }
    const needed = Math.max(agreeMin, Math.ceil(agreeFraction * (slices - 1)));

    const cols = Math.floor(width / cell);
    const rows = Math.floor(sliceHeight / cell);
    const hit = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (cellDetail(px, width, c * cell, r * cell, cell) <= detailMin) continue;
            let agree = 0;
            for (let s = 1; s < slices; s++) {
                const d = cellDifference(px, width, c * cell, r * cell, c * cell, s * sliceHeight + r * cell, cell);
                if (d < sameMax) agree++;
            }
            if (agree >= needed) hit.push({c, r, agree});
        }
    }
    if (!hit.length) {
        return [];
    }

    // Neighbouring cells are one overlay. Grown rather than clustered, because a widget is
    // a contiguous box and this keeps the answer a rectangle a person can check.
    const key = (c, r) => `${c},${r}`;
    const left = new Set(hit.map((h) => key(h.c, h.r)));
    const regions = [];
    for (const start of hit) {
        if (!left.has(key(start.c, start.r))) continue;
        const stack = [start];
        let minC = start.c;
        let maxC = start.c;
        let minR = start.r;
        let maxR = start.r;
        let agree = start.agree;
        left.delete(key(start.c, start.r));
        while (stack.length) {
            const {c, r} = stack.pop();
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const k = key(c + dc, r + dr);
                if (!left.has(k)) continue;
                left.delete(k);
                const found = hit.find((h) => key(h.c, h.r) === k);
                stack.push(found);
                minC = Math.min(minC, found.c);
                maxC = Math.max(maxC, found.c);
                minR = Math.min(minR, found.r);
                maxR = Math.max(maxR, found.r);
                agree = Math.min(agree, found.agree);
            }
        }
        const cells = (maxC - minC + 1) * (maxR - minR + 1);
        if (cells < minCells) continue;
        regions.push({
            x: minC * cell,
            y: minR * cell,
            w: (maxC - minC + 1) * cell,
            h: (maxR - minR + 1) * cell,
            slices: agree + 1,
            of: slices,
        });
    }

    return regions.sort((a, b) => b.w * b.h - a.w * a.h);
}

/** The same question, asked of a file. */
export async function overlaysInPng(path, sliceHeight, opts = {}) {
    const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});

    return overlayRegions(data, info.width, info.height, sliceHeight, opts);
}

/** One line for a human, or null when there is nothing to say. */
export function overlayWarning(regions, pageHeight) {
    if (!regions?.length) {
        return null;
    }
    const worst = regions[0];
    const covered = regions.reduce((a, r) => a + r.w * r.h * r.slices, 0);
    const share = pageHeight > 0 ? covered / (1440 * pageHeight) : 0;

    return `a ${worst.w}x${worst.h} region at ${worst.x},${worst.y} of each slice is identical in `
        + `${worst.slices} of ${worst.of} of them, so it is an overlay pinned to the viewport that the `
        + 'DOM census could not reach — a chat widget or a cookie chip, most often. Whatever it covers '
        + `was never photographed, so those regions (about ${(share * 100).toFixed(1)}% of the page) are `
        + 'unmeasured rather than content';
}
