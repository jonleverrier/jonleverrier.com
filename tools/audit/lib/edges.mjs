/**
 * EDGES
 *
 * Greyscale → Sobel → non-maximum suppression → hysteresis. A Canny edge map.
 *
 *   node --test tools/audit/test/edges.test.mjs
 *
 * EDGES, NOT BRIGHTNESS, and that is the whole reason this file exists. A gutter
 * found on raw brightness is a light band, so a dark-themed page inverts every
 * answer and a page with a full-bleed photograph has no gutters at all. An edge map
 * asks "is anything happening here", which is the actual question, and a dark page
 * and a light page behave identically under it.
 *
 * The limitation worth knowing: the thresholds below are absolute, not adaptive. A
 * very low-contrast page yields a sparse map and will under-cut. If that shows up,
 * scale the thresholds from the image's gradient distribution rather than raising
 * these constants, which would over-cut everything else.
 *
 * THIS FILE IS WHERE THE TOOL'S MEMORY IS SPENT: six arrays the size of the image, all
 * live at once, about 18 bytes a pixel. MAX_IMAGE_HEIGHT is the declared ceiling on that
 * and the only page-size limit anywhere in the tool.
 */
import sharp from 'sharp';

export const CANNY_LOW = 20;
export const CANNY_HIGH = 60;

export function toGrey(data, width, height) {
    const grey = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < grey.length; i++, p += 3) {
        grey[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    }

    return grey;
}

export function sobel(grey, width, height) {
    const mag = new Float32Array(width * height);
    const dir = new Uint8Array(width * height);
    const at = (x, y) => grey[y * width + x];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
                + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
            const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
                + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
            const i = y * width + x;
            mag[i] = Math.hypot(gx, gy);
            // Quantise to 0=|, 1=/, 2=—, 3=\ for non-max suppression.
            const a = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
            dir[i] = a < 22.5 || a >= 157.5 ? 2 : a < 67.5 ? 1 : a < 112.5 ? 0 : 3;
        }
    }

    return {mag, dir};
}

export function nonMaxSuppress(mag, dir, width, height) {
    const out = new Float32Array(width * height);
    // Invariant: neighbours[k] must lie on the line AT BUCKET k'S OWN ANGLE (the
    // gradient direction, i.e. across the edge), not along the edge itself. Get this
    // wrong and diagonal edges erode lengthwise into slivers while cardinal edges
    // (which happen to be the only case an easy test covers) look untouched.
    const neighbours = [[0, -1, 0, 1], [-1, -1, 1, 1], [-1, 0, 1, 0], [1, -1, -1, 1]];
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const [ax, ay, bx, by] = neighbours[dir[i]];
            const a = mag[(y + ay) * width + (x + ax)];
            const b = mag[(y + by) * width + (x + bx)];
            out[i] = mag[i] >= a && mag[i] >= b ? mag[i] : 0;
        }
    }

    return out;
}

/**
 * Strong pixels survive; weak pixels survive only if connected to a strong one.
 *
 * THE STACK IS A TYPED ARRAY WITH A TOP INDEX, NOT A JS ARRAY, and the capacity is a
 * proof rather than a guess: every index is pushed at most once — a strong pixel is
 * marked in `edges` as it is seeded, and a weak one is only pushed behind `!edges[n]` —
 * so `width * height` entries is the exact worst case and there is nothing to grow.
 *
 * It used to be `const stack = []`, filled with every strong pixel in the image before a
 * single one was popped. Measured: 42,796 entries on the jonleverrier fixture (2.3% of
 * its pixels) and 238,142 on retail (4.4%). So on an ordinary page this change COSTS
 * memory — a fixed Int32Array is 7.5MB and 21.6MB against the 0.3MB and 1.9MB those
 * stacks peaked at. It is still the right trade, for the case neither fixture is: a
 * high-contrast page seeds close to one entry per pixel, a JS array reaches that by
 * repeated reallocation inside V8's heap — where running out is a fatal heap error —
 * and a typed array's buffer is allocated once, outside it, and cannot move.
 */
export function hysteresis(mag, width, height, low = CANNY_LOW, high = CANNY_HIGH) {
    const edges = new Uint8Array(width * height);
    const stack = new Int32Array(width * height);
    let top = 0;
    for (let i = 0; i < mag.length; i++) {
        if (mag[i] >= high) {
            edges[i] = 1;
            stack[top++] = i;
        }
    }
    while (top > 0) {
        const i = stack[--top];
        const x = i % width;
        const y = (i / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const n = ny * width + nx;
                if (!edges[n] && mag[n] >= low) {
                    edges[n] = 1;
                    stack[top++] = n;
                }
            }
        }
    }

    return edges;
}

/**
 * The tallest image this will decode, in pixels.
 *
 * IT IS A MEMORY BUDGET, AND NOTHING ELSE. It used to be justified as a provenance check
 * too — 16,384 is Chromium's texture ceiling, so a taller PNG "did not come out of phase
 * 1" — and that has been false twice over. Phase 1 would happily write a 24,746px file for
 * a page that tall, with everything below 16,384 blank; and now that it photographs the
 * page a viewport at a time and stitches the slices, a 24,746px file is a taller page
 * FULLY PAINTED. Neither is a reason to refuse it. Running out of memory is.
 *
 * This function holds roughly 18 bytes per pixel at once — raw RGB, grey, mag, dir, thin,
 * edges and the hysteresis stack — so 1440 x 16,384 is about 425MB, which is survivable. A
 * 60,000px page would be 1.5GB, and a queue worker taking URLs from strangers should
 * decline that in a sentence rather than discover it as an OOM. Width is not capped here
 * because sharp already refuses more than 268M pixels by default.
 *
 * The consequence worth knowing: a page taller than this is captured correctly and NOT
 * segmented. That is one honest refusal rather than a confident percentage of a prefix,
 * but it is a refusal, and raising the number is a deliberate decision about how much
 * memory one audit may take.
 */
export const MAX_IMAGE_HEIGHT = 16384;

/** raw RGB 3 + grey 1 + mag 4 + dir 1 + thin 4 + edges 1 + the hysteresis stack 4. */
export const BYTES_PER_PIXEL = 18;

export async function edgeMapFromPng(path) {
    // ASKED BEFORE DECODING. metadata() reads the header only, so a page too tall to
    // segment is refused for the price of a file open — checking after toBuffer() would
    // mean allocating the very hundreds of megabytes the cap exists to avoid.
    const {width: declaredWidth, height: declaredHeight} = await sharp(path).metadata();
    if (declaredHeight > MAX_IMAGE_HEIGHT) {
        // THE MESSAGE SAYS WHAT THE LIMIT IS, not what it guesses about the file. It used
        // to claim "this did not come from a capture", and then "everything below is blank
        // background" — the first was never true and the second stopped being true when
        // phase 1 started stitching viewport shots. Whatever is in the image, this
        // function cannot hold it.
        throw new Error(`this image is ${declaredHeight}px tall and the limit is ${MAX_IMAGE_HEIGHT}px. `
            + `Segmenting it needs about ${Math.round(declaredHeight * declaredWidth * BYTES_PER_PIXEL / 1e6)}MB `
            + 'of arrays held at once, which is the budget one audit is allowed. Crop it, or raise '
            + 'MAX_IMAGE_HEIGHT in lib/edges.mjs deliberately. Nothing is claimed here about whether '
            + 'the image is any good: a stitched capture of a page this tall is fully painted, and '
            + 'meta.capture says which path took it');
    }

    const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width, height} = info;
    const grey = toGrey(data, width, height);
    const {mag, dir} = sobel(grey, width, height);
    const thin = nonMaxSuppress(mag, dir, width, height);

    return {edges: hysteresis(thin, width, height), width, height};
}
