/**
 * RECTS
 *
 * The door phase 1's DOM rects come in through, and the only place that decides whether
 * a rects file is usable.
 *
 *   node --test tools/audit/test/rects.test.mjs
 *
 * WHY THIS EXISTS: `lib/blocks.mjs` rests the whole measurement on exact integer
 * arithmetic — "every rect is whole pixels, so there is no tolerance to tune and no
 * floating-point slack to hide a bug in" — and nothing enforced it. Phase 1 rounds, but
 * the README deliberately invites a file from elsewhere ("a screenshot from somewhere
 * else, an older capture"), and `JSON.parse` will hand over whatever is in it.
 *
 * A single fractional coordinate voids the invariant. Measured: a rect of height
 * 100.33333333333334 — what getBoundingClientRect returns for a three-column grid, a
 * fractional line-height, or anything under `transform: scale` — snaps a cut onto
 * 200.33333333333334, and the two children then sum to 119999.99999999999 against an
 * image of 120000. Over 3,000,000 random triples, 4.6% of fractional cuts break exact
 * area equality. Phase 2 now refuses to write a tree that fails, so that file did not
 * produce a wrong number — it produced a run that exited 1 blaming the segmenter for
 * something the rects did.
 *
 * ROUNDING, NOT REJECTING, and that is a ruling rather than a convenience: phase 1
 * rounds already, so a fractional file is by definition an out-of-house one, and its
 * coordinates are fractional because a browser's layout is, not because they are wrong.
 * Rounding preserves the premise and keeps the file usable; rejecting it would turn a
 * perfectly good screenshot into a failed audit over a third of a pixel.
 *
 * WHAT CANNOT BE REPAIRED IS DROPPED, AND SAID OUT LOUD. A rect with no numbers in it
 * is not a rect, and guessing one would be inventing evidence. The counts go to stderr
 * because a run that quietly lost its rects looks like a worse segmenter — the README's
 * own gotcha — and because `[1, 2, 3]` used to be accepted with stderr cheerfully
 * reporting "snapping cuts to 3 DOM rects" while snapping to nothing at all.
 *
 * The limitation worth knowing: this checks that a rect is ARITHMETICALLY sound, not
 * that it describes anything on the page. A rects file from a different capture of the
 * same site passes every check here and snaps every cut to the wrong place.
 */
import {existsSync, readFileSync} from 'node:fs';

/** What a value is, for a message a person has to act on. */
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

/**
 * Repair what can be repaired, drop what cannot, and count both.
 *
 * Returns `{rects, rounded, dropped}`. Throws when the file is not an array at all, and
 * when it is an array in which nothing is a rect — the second because a caller told
 * "snapping cuts to N rects" has been told something false, which is worse than an
 * error. An EMPTY array is not an error: a page with no elements is a real answer.
 *
 * `text` and `boxed` are decoration — they name a heading and a module container — so a
 * bad one is coerced to the value an absent one already means, rather than costing a
 * geometrically sound rect its place. `boxed` is coerced because it is read for its
 * truthiness, where the string "false" would be true. `transparentAncestor` is NOT, and
 * deliberately: it is only ever read as `=== true` (see lib/painted.mjs), so nothing a
 * file can put there survives the reading, and a rect this function did not have to
 * touch should come back out the way it went in.
 */
export function normaliseRects(value) {
    if (!Array.isArray(value)) {
        throw new Error(`rects must be an array of rects, got ${describe(value)}`);
    }

    const rects = [];
    let rounded = 0;
    let dropped = 0;
    for (const r of value) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
            dropped++;
            continue;
        }
        const {x, y, w, h} = r;
        if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) || typeof r.tag !== 'string') {
            dropped++;
            continue;
        }
        const box = {x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h)};
        // Nothing an element can be. Phase 1 discards these before they are written
        // (`r.width < 1 || r.height < 1`), so this only ever fires on a file from
        // somewhere else, and a zero-area rect would contribute a cut candidate that
        // marks nothing.
        if (box.w < 1 || box.h < 1) {
            dropped++;
            continue;
        }
        if (box.x !== x || box.y !== y || box.w !== w || box.h !== h) {
            rounded++;
        }
        rects.push({
            ...r,
            ...box,
            text: typeof r.text === 'string' ? r.text : '',
            boxed: r.boxed === true,
        });
    }

    if (value.length > 0 && rects.length === 0) {
        throw new Error(`rects contained ${value.length} entr${value.length === 1 ? 'y' : 'ies'} and none `
            + 'of them is a rect: x, y, w and h must be finite numbers and tag a string');
    }

    return {rects, rounded, dropped};
}

/**
 * The rects beside a capture, or `null` when there genuinely are none.
 *
 * `null` MEANS THE FILE IS NOT THERE, and nothing else. A file that exists and parses to
 * nothing used to be reported as "no rects.json in <dir>" with the file sitting right
 * there — the same words for "you never captured rects" and "your rects are broken".
 */
export function loadRects(path) {
    if (!existsSync(path)) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new Error(`${path} is not valid JSON: ${e.message}`);
    }

    try {
        return normaliseRects(parsed);
    } catch (e) {
        throw new Error(`${path}: ${e.message}`);
    }
}
