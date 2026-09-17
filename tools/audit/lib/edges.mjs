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
    const neighbours = [[0, -1, 0, 1], [1, -1, -1, 1], [-1, 0, 1, 0], [-1, -1, 1, 1]];
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

/** Strong pixels survive; weak pixels survive only if connected to a strong one. */
export function hysteresis(mag, width, height, low = CANNY_LOW, high = CANNY_HIGH) {
    const edges = new Uint8Array(width * height);
    const stack = [];
    for (let i = 0; i < mag.length; i++) {
        if (mag[i] >= high) {
            edges[i] = 1;
            stack.push(i);
        }
    }
    while (stack.length) {
        const i = stack.pop();
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
                    stack.push(n);
                }
            }
        }
    }

    return edges;
}

export async function edgeMapFromPng(path) {
    const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width, height} = info;
    const grey = toGrey(data, width, height);
    const {mag, dir} = sobel(grey, width, height);
    const thin = nonMaxSuppress(mag, dir, width, height);

    return {edges: hysteresis(thin, width, height), width, height};
}
