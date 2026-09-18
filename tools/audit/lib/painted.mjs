/**
 * PAINTED
 *
 * What the DOM says is in a block, against what was actually painted there.
 *
 *   node --test tools/audit/test/painted.test.mjs
 *
 * WHY THIS EXISTS. The capture forces `prefers-reduced-motion: reduce`, because a
 * carousel or an entrance animation makes the screenshot non-deterministic and phase 2
 * has to be deterministic. Content revealed on scroll therefore never fires, and
 * boondmanager.com's testimonial cards are in the DOM, in `rects.json`, and absent from
 * the pixels. The README recorded this as a limitation nothing could detect.
 *
 * It is detectable, because the two records contradict each other. A block of 1440x1199
 * there holds 102 elements carrying text or media, and 100 of them have not one painted
 * pixel inside them; the block as a whole is 0.4% ink. A page cannot be measured that
 * way and reported as empty space.
 *
 * THE TRAP IS A BLOCK THAT IS SPARSE ON PURPOSE, and it is the whole difficulty.
 * klark.ai's client logo strip is six logos with generous padding — correct, deliberate,
 * and 4.3% ink. A detector keyed on ink alone would flag it and be wrong. So the
 * decision is made on the CONTRADICTION and never on the emptiness: of that strip's 22
 * content elements, NONE is blank. Of boondmanager's 102, 100 are. Measured across every
 * page available, a correctly rendered block runs 0-16% blank and the ones that did not
 * render run 77-100%, which is a gap no threshold is balanced inside.
 *
 * INK IS MEASURED AGAINST THE BACKGROUND EACH ROW SITS ON, not against a page-wide
 * colour. klark's strip sits on rgb(253,245,234) while a dark section elsewhere on the
 * same page needs its own reference, and boondmanager's empty region is a dark void with
 * a pale band across the bottom eighth of it — one colour for the block makes that band
 * read as 10% ink, when the band is the one part of the region that is painted with
 * nothing. It is also a different measure from the edge map, which fires at boundaries:
 * a solid filled logo has almost no edges inside it and a busy outline has a great many,
 * so edges cannot say how much of a block was painted at all.
 *
 * The limitations worth knowing:
 *
 *   - It cannot say WHY the pixels are missing. Reduced motion, a lazy image that never
 *     loaded, a script that failed and a deliberately hidden panel all look the same from
 *     here, which is why the note says the region is unmeasured rather than naming a
 *     cause.
 *   - An element painted in a colour within INK_TOLERANCE of its background — grey on
 *     grey, a placeholder — counts as blank. Nothing visible is there, so that is
 *     arguably the right answer.
 *   - A row that crosses two backgrounds, such as a block split into two coloured
 *     columns, takes the wider one as its background and reads the narrower as ink. That
 *     direction is deliberate: it makes such a block look MORE painted, and a false
 *     negative here costs a note nobody reads rather than a caveat on a correct number.
 */
import sharp from 'sharp';
import {MAX_IMAGE_HEIGHT} from './edges.mjs';

/** Elements that are content even when they carry no text of their own. */
const MEDIA_TAGS = new Set(['img', 'video', 'canvas', 'picture', 'svg', 'iframe']);

/**
 * How far from its row's background a pixel has to be to count as ink, per channel.
 *
 * MEASURED against the two populations this tells apart. At 8, the faint banding in a
 * flat background and a screenshot's own compression start counting as ink, and
 * boondmanager's empty blocks climb off the floor. At 32, antialiased body text on a
 * tinted background stops counting and kohde's footer — small white text on black, 2.5%
 * ink, entirely correct — reads as unpainted. Every page measured gives the same answer
 * anywhere between 12 and 24; 16 is the middle of that band.
 */
export const INK_TOLERANCE = 16;

/** Colours are bucketed 16 to a channel, so a background survives dithering. */
const BUCKET_SHIFT = 4;
const BUCKETS = (256 >> BUCKET_SHIFT) ** 3;

/**
 * The raw RGB of a PNG, for measuring what was painted.
 *
 * A SECOND DECODE, deliberately: `edgeMapFromPng` throws its RGB away after the
 * greyscale pass, and holding it through the whole segmentation to save one decode would
 * cost three bytes a pixel across the most expensive part of the run. The height cap is
 * the same one edges.mjs enforces, for the same reason.
 */
export async function pixelsFromPng(path) {
    const {height: declaredHeight} = await sharp(path).metadata();
    if (declaredHeight > MAX_IMAGE_HEIGHT) {
        throw new Error(`this image is ${declaredHeight}px tall and the limit is ${MAX_IMAGE_HEIGHT}px`);
    }
    const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});

    return {pixels: data, width: info.width, height: info.height};
}

/**
 * Ink counts for the whole page, as one prefix sum per row.
 *
 * `at(y, x)` is the number of ink pixels in row `y` strictly left of `x`, so the ink in
 * any rectangle is a subtraction per row and an element can be measured as cheaply as a
 * block. Built once per page: doing it per rect instead meant re-reading the pixels
 * under every nested element, which on a page of a thousand rects is several times the
 * image.
 *
 * THE BACKGROUND IS THE ROW'S OWN COMMONEST COLOUR. See the header for why it is per row
 * rather than per page or per block, and what that costs.
 */
export function inkPrefix(pixels, width, height) {
    const stride = width + 1;
    const prefix = new Int32Array(stride * height);
    const counts = new Int32Array(BUCKETS);
    const sumR = new Float64Array(BUCKETS);
    const sumG = new Float64Array(BUCKETS);
    const sumB = new Float64Array(BUCKETS);
    // Only the buckets a row actually used are cleared between rows: zeroing 4096 entries
    // per row costs more than the measurement itself on a tall page.
    const touched = new Int32Array(width);

    for (let y = 0; y < height; y++) {
        let seen = 0;
        let p = y * width * 3;
        for (let x = 0; x < width; x++, p += 3) {
            const bucket = ((pixels[p] >> BUCKET_SHIFT) << (2 * (8 - BUCKET_SHIFT)))
                | ((pixels[p + 1] >> BUCKET_SHIFT) << (8 - BUCKET_SHIFT))
                | (pixels[p + 2] >> BUCKET_SHIFT);
            if (counts[bucket] === 0) touched[seen++] = bucket;
            counts[bucket]++;
            sumR[bucket] += pixels[p];
            sumG[bucket] += pixels[p + 1];
            sumB[bucket] += pixels[p + 2];
        }

        let modal = touched[0];
        for (let i = 1; i < seen; i++) {
            if (counts[touched[i]] > counts[modal]) modal = touched[i];
        }
        // The MEAN of the modal bucket, not the bucket's centre: a background of
        // rgb(253,245,234) sits near the edge of its bucket, and the centre would count
        // the background itself as most of a step of ink everywhere.
        const n = counts[modal];
        const mr = sumR[modal] / n;
        const mg = sumG[modal] / n;
        const mb = sumB[modal] / n;

        const row = y * stride;
        p = y * width * 3;
        let total = 0;
        for (let x = 0; x < width; x++, p += 3) {
            prefix[row + x] = total;
            if (Math.abs(pixels[p] - mr) > INK_TOLERANCE
                || Math.abs(pixels[p + 1] - mg) > INK_TOLERANCE
                || Math.abs(pixels[p + 2] - mb) > INK_TOLERANCE) {
                total++;
            }
        }
        prefix[row + width] = total;

        for (let i = 0; i < seen; i++) {
            const bucket = touched[i];
            counts[bucket] = 0;
            sumR[bucket] = 0;
            sumG[bucket] = 0;
            sumB[bucket] = 0;
        }
    }

    return {prefix, width, height};
}

/** The number of painted pixels inside `box`, from a page's ink prefix. */
export function inkCount({prefix, width, height}, box) {
    const x0 = Math.max(0, Math.min(width, box.x));
    const x1 = Math.max(0, Math.min(width, box.x + box.w));
    const y0 = Math.max(0, Math.min(height, box.y));
    const y1 = Math.max(0, Math.min(height, box.y + box.h));
    if (x1 <= x0 || y1 <= y0) {
        return 0;
    }

    const stride = width + 1;
    let ink = 0;
    for (let y = y0; y < y1; y++) {
        ink += prefix[y * stride + x1] - prefix[y * stride + x0];
    }

    return ink;
}

/** The share of `box` that is painted, between 0 and 1. */
export function inkFraction(page, box) {
    const w = Math.max(0, Math.min(page.width, box.x + box.w) - Math.max(0, box.x));
    const h = Math.max(0, Math.min(page.height, box.y + box.h) - Math.max(0, box.y));

    return w * h === 0 ? 0 : inkCount(page, box) / (w * h);
}

/**
 * The elements inside `block` that carry text or media.
 *
 * FULLY INSIDE, not merely overlapping: a block is a partition of the page, and an
 * element straddling a boundary belongs to neither side more than the other. Counting
 * overlaps would credit a block with its neighbour's content and hide exactly the
 * contradiction this is looking for.
 *
 * Nesting is NOT unwound. An element's `text` includes its descendants', so a wrapper
 * and the paragraph inside it both count — and both are blank when the region did not
 * render, which is the signal. The thresholds were measured against this definition.
 */
export function contentRects(rects, block) {
    if (!Array.isArray(rects)) {
        return [];
    }

    return rects.filter((r) => {
        const inside = r.x >= block.x && r.y >= block.y
            && r.x + r.w <= block.x + block.w && r.y + r.h <= block.y + block.h;
        if (!inside) return false;

        return MEDIA_TAGS.has(r.tag) || (typeof r.text === 'string' && r.text.trim() !== '');
    });
}

/**
 * When a block's DOM and its pixels contradict each other.
 *
 * MEASURED ACROSS ELEVEN PAGES — both fixtures, boondmanager, klark, clearleft, hsbc,
 * natwest, kohde, jtcgroup, switch.je and lloydsbank — and both numbers sit in the
 * middle of a gap rather than on the edge of an example.
 *
 *   BLANK SHARE. Regions that did not render: 98% of 102 elements, 84% of 31, 77% of 61
 *   on boondmanager, and 100% of 9 on kohde's "Let's talk" panel, which is dark grey
 *   text on a dark background and invisible in the capture. Regions that rendered
 *   correctly: klark's logo strip 0% of 22, its header 0% of 24, kohde's footer 3% of
 *   33, boondmanager's own footer 0% of 110, and the highest anywhere 16% of 19. The
 *   two populations are separated by a factor of five with nothing between them.
 *
 *   MIN_RECTS. Among blocks that pass the blank-share gate, every correctly rendered one
 *   holds TWO elements — a decorative span, an icon that draws outside its own box — and
 *   the smallest genuine failure holds 9. 6 is three times the first and two thirds of
 *   the second. It is doing real work: at 3, and a blank share of 40% rather than 50%, a
 *   five-element block of the jonleverrier fixture comes into range.
 *
 * The ink fraction is recorded and NOT used as a gate. It is the measure a later phase
 * needs — a block can be labelled "trust" and be 96% whitespace — and as a detector it
 * is what would flag klark's strip, which is the mistake this file exists to avoid.
 */
export const UNPAINTED = {minBlankShare: 0.5, minRects: 6};

/**
 * Every block whose DOM says content and whose pixels say nothing, with its numbers.
 *
 * In tree order, and machine-readable on purpose: the same measurement answers "how much
 * of this block is actually whitespace", which a report needs to describe space honestly.
 */
export function unpaintedBlocks(page, blocks, rects, opts = UNPAINTED) {
    const {minBlankShare, minRects} = {...UNPAINTED, ...opts};
    if (!page || !Array.isArray(rects) || rects.length === 0) {
        return [];
    }

    const found = [];
    for (const block of blocks) {
        const inside = contentRects(rects, block);
        if (inside.length < minRects) continue;
        const blank = inside.filter((r) => inkCount(page, r) === 0).length;
        if (blank < minBlankShare * inside.length) continue;
        found.push({
            x: block.x, y: block.y, w: block.w, h: block.h,
            domRects: inside.length,
            blankRects: blank,
            // Three decimal places: a fraction, kept short enough to read in the file.
            ink: Math.round(inkFraction(page, block) * 1000) / 1000,
        });
    }

    return found;
}

/** The sentence for a terminal and for `notes`. */
export function unpaintedWarning(found) {
    if (!found || found.length === 0) {
        return null;
    }
    const worst = found.reduce((a, b) => (a.blankRects >= b.blankRects ? a : b));
    const where = found.length === 1 ? 'one block holds' : `${found.length} blocks hold`;

    return `${where} content that is in the DOM and was never painted — the worst is `
        + `${worst.w}x${worst.h} at y=${worst.y}, where ${worst.blankRects} of ${worst.domRects} elements `
        + `carrying text or media have no painted pixel inside them and the block is ${(worst.ink * 100).toFixed(1)}% `
        + 'ink. Scroll-reveal content that never fired looks exactly like this, and the capture forces '
        + 'reduced motion. Those regions are unmeasured, not empty';
}
