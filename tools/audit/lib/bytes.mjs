/**
 * BYTES
 *
 * What this page actually shipped, measured on the load we were doing anyway.
 *
 *   node --test tools/audit/test/bytes.test.mjs
 *
 * THIS IS NOT PageSpeed's `total-byte-weight`, AND THE DIFFERENCE IS THE SCROLL.
 * Lighthouse loads a page and never goes down it, so everything lazy-loaded is missing
 * from its count. The capture has to scroll — that is how it photographs a page taller
 * than a viewport — so this census sees what a visitor who read the page would have
 * downloaded. Measured on kohde.agency: 1,229 KiB at load, 2,710 KiB after the scroll
 * pass, against PSI's 4,924 KiB. Three numbers for one page. The one that belongs beside
 * a measurement of the whole page is the one taken over the whole page.
 *
 * AT LOAD AND AFTER SCROLL ARE BOTH KEPT, because the gap between them is the finding. A
 * page that doubles on scroll is deferring work, which is usually right; a page already
 * carrying everything at load is not. Either number alone hides that.
 *
 * ENCODED LENGTH, NOT RESOURCE SIZE. `encodedDataLength` is bytes on the wire, compression
 * included, which is what a visitor pays for. Lighthouse reports the same thing but a
 * report saying "4 MB" about a gzipped 900KB transfer is describing a cost nobody bore.
 *
 * FREE, in the sense that matters: no key, no quota, no second page load, no external
 * service that can be down. It is a CDP listener on a session the capture already opens.
 *
 * The limitation worth knowing: this measures OUR load, from wherever this runs, with a
 * cold cache and no ad-blocker. A visitor with a warm cache downloads far less. It is a
 * measure of what the page asks for, not of what any one person fetched — which is the
 * right question for "how much is this page spending", and the wrong one for "how slow
 * was it for Jane". Speed is lib/psi.mjs's job, and it is throttled where this is not.
 */

/** Resource types worth naming separately in a report. Anything else lands in `other`. */
export const BYTE_TYPES = ['Document', 'Stylesheet', 'Script', 'Image', 'Media', 'Font', 'XHR', 'Fetch'];

/** Bytes below this on a whole page mean the census never attached. */
export const CENSUS_MIN_BYTES = 1024;

const empty = () => ({bytes: 0, requests: 0});

/**
 * Start counting on an open CDP session. Returns a handle with `mark` and `result`.
 *
 * `mark(name)` freezes a running total under that name — the capture calls it once when
 * the page has loaded and once when the scroll pass is done — and `result()` returns the
 * marks plus the final totals.
 *
 * NOTHING HERE MAY THROW INTO THE CAPTURE. A byte count is the least important thing this
 * tool produces; a capture that died because a listener misfired would be the most
 * expensive. Every handler is total, and `result()` answers from whatever it has.
 */
export async function countBytes(cdp) {
    const types = new Map();
    const seen = new Map();
    const marks = {};
    let failed = null;

    try {
        await cdp.send('Network.enable');
    } catch (e) {
        // Recorded rather than thrown: the capture goes on without a weight, and the
        // absence is declared instead of reading as a page that shipped nothing.
        failed = e.message;
    }

    cdp.on('Network.responseReceived', (e) => {
        seen.set(e.requestId, e.type ?? 'Other');
    });
    cdp.on('Network.loadingFinished', (e) => {
        const kind = seen.get(e.requestId) ?? 'Other';
        const held = types.get(kind) ?? empty();
        held.bytes += e.encodedDataLength ?? 0;
        held.requests += 1;
        types.set(kind, held);
    });

    const total = () => [...types.values()].reduce(
        (a, t) => ({bytes: a.bytes + t.bytes, requests: a.requests + t.requests}),
        empty(),
    );

    return {
        mark(name) {
            marks[name] = total();
        },
        result() {
            if (failed) {
                return {measured: false, why: failed};
            }
            const all = total();

            return {
                measured: all.bytes >= CENSUS_MIN_BYTES,
                why: all.bytes >= CENSUS_MIN_BYTES ? null : 'the census recorded almost nothing',
                atLoad: marks.atLoad ?? null,
                afterScroll: marks.afterScroll ?? all,
                byType: byType(types),
            };
        },
    };
}

/** The named types, largest first, with everything unnamed collapsed into `other`. */
export function byType(types) {
    const out = [];
    let other = empty();
    for (const [kind, held] of types) {
        if (BYTE_TYPES.includes(kind)) {
            out.push({type: kind.toLowerCase(), bytes: held.bytes, requests: held.requests});
        } else {
            other = {bytes: other.bytes + held.bytes, requests: other.requests + held.requests};
        }
    }
    if (other.requests > 0) {
        out.push({type: 'other', ...other});
    }

    // Largest first, because the first row is the answer — the same ruling the report's
    // own table is built on. Ties break on the name so two runs agree byte for byte.
    return out.sort((a, b) => (b.bytes - a.bytes) || a.type.localeCompare(b.type));
}

/**
 * The sentence a reader gets, or null when there is nothing worth saying.
 *
 * DELIBERATELY NOT A VERDICT. "14.7 MB is too much" depends on what the page is for, and
 * this file has no way to know. It states what was shipped and what the largest share of
 * it was; whether that is waste is an argument the report makes by putting it beside how
 * much of the page is drawn on.
 */
export function bytesSummary(census) {
    if (!census || census.measured === false) {
        return null;
    }
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const after = census.afterScroll ?? {bytes: 0, requests: 0};
    const biggest = census.byType?.[0];
    const grew = census.atLoad && after.bytes > census.atLoad.bytes
        ? `, ${mb(census.atLoad.bytes)} of it before any scrolling`
        : '';
    const led = biggest && after.bytes > 0
        ? ` — ${Math.round((biggest.bytes / after.bytes) * 100)}% of it ${biggest.type}`
        : '';

    return `this page shipped ${mb(after.bytes)} over ${after.requests} requests${grew}${led}`;
}
