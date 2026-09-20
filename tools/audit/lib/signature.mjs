/**
 * SIGNATURE
 *
 * Has this page actually changed since we last measured it?
 *
 *   node --test tools/audit/test/signature.test.mjs
 *
 * A vision model does not return the same answer twice. Measured over three runs of one
 * image: block counts of 10, 11 and 11, boundaries agreeing to within 20px, and the
 * largest block reported at 19.2%, 21.1% and 17.7% of the page. Snapping boundaries onto
 * real element edges recovers some of that and not all of it — where two runs genuinely
 * disagree about whether a region is one section or two, nothing can reconcile them.
 *
 * So a page is audited ONCE and the answer stored, and the number a prospect reads never
 * moves underneath them. The question this file answers is when that stored answer has
 * stopped describing the site.
 *
 * NOT A HASH OF THE SCREENSHOT. A hero carousel or a rotating photograph changes those
 * pixels on every single load, which would re-audit an unchanged page every time — paying
 * for a call, and returning a slightly different number for a site nobody had touched.
 * The signature is STRUCTURAL: how tall the page is, how many elements it has, what they
 * say, and where they sit.
 *
 * SORTED, because rects.json's order is the DOM's and is not stable between captures. An
 * unsorted digest would report a change every time a framework rendered its children in a
 * different order, which is the same failure as hashing the pixels.
 *
 * THE QUESTION IS PART OF THE PAGE. A stored answer stops describing the site when the
 * site changes — and equally when we change what we asked. Defining `brand` in the prompt
 * turned three atkinsonsca.co.uk photo bands from `unclassified` into a category, on a
 * page whose markup had not moved a pixel; without the prompt in this digest the cache
 * would have served the old answer forever and the change would have looked like a no-op.
 * So TILE_PROMPT is hashed in beside the structure, and editing it re-audits everything.
 *
 * The limitation worth knowing: a site that changes only its imagery — a new hero
 * photograph behind the same layout and copy — will not be re-audited, and its report will
 * be right about the proportions and stale about the picture. That is the intended trade,
 * and it is the right way round: the report is about how space is spent, not about what is
 * in the photographs.
 */
import {createHash} from 'node:crypto';
import {TILE_PROMPT} from './vision.mjs';

const digest = (parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);

/** The inputs, separately, so a mismatch can be explained rather than merely asserted. */
export function signatureFacts(meta, rects) {
    const list = Array.isArray(rects) ? rects : [];
    const lines = list
        .map((r) => `${r.tag}|${r.x},${r.y},${r.w},${r.h}|${String(r.text ?? '').trim().slice(0, 120)}`)
        .sort();

    return {
        height: meta?.image?.height ?? meta?.fullHeight ?? 0,
        rectCount: list.length,
        textDigest: digest(lines),
        edgeDigest: digest(list.map((r) => `${r.y}:${r.y + r.h}`).sort()),
        promptDigest: digest([TILE_PROMPT]),
    };
}

export function pageSignature(meta, rects) {
    const f = signatureFacts(meta, rects);

    return digest([f.height, f.rectCount, f.textDigest, f.edgeDigest, f.promptDigest]);
}
