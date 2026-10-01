/**
 * PSI
 *
 * How fast this page is, from Lighthouse via the PageSpeed Insights API.
 *
 *   node --test tools/audit/test/psi.test.mjs
 *
 * LAB ONLY, AND FIELD DATA IS DELIBERATELY NOT COLLECTED. PSI can answer twice over: a
 * LAB run Lighthouse performs under simulated throttling, and FIELD data from the Chrome
 * UX Report — real Chrome visitors over a rolling 28 days, which is unarguably the better
 * number. It is not here, and the reason is the client base rather than the metric.
 *
 * CrUX needs enough traffic before Google will report on a site at all. Measured on the
 * two probes: natwest.com has field data for both page and origin; kohde.agency has
 * neither, and kohde is what almost every prospect for this tool looks like. Carrying
 * field data would mean a report with a section that exists for perhaps one site in
 * twenty, two shapes of email, and a conditional in every piece of copy written about it.
 * Lab was complete on BOTH sites — all seven metrics, big and small alike — so taking lab
 * alone buys one report, one shape, and a number that is there every time.

 *
 * DESKTOP, BECAUSE THE CAPTURE IS DESKTOP. PSI defaults to mobile, which is the right
 * default for Google and the wrong one here: a mobile speed score printed beside a
 * measurement of a 1440x900 layout describes two different pages, and it is exactly the
 * seam a reader notices.
 *
 * THE SPEED IS OURS TO ASK FOR AND THE WEIGHT IS NOT. `total-byte-weight` is in this
 * response and is deliberately ignored: Lighthouse loads the page and never scrolls it,
 * so its byte count misses everything lazy-loaded. On kohde.agency the capture's own
 * census measured 1,229 KiB at load and 2,710 KiB after the scroll pass — more than
 * double — against PSI's 4,924 KiB, a third number again. Two page weights in one report
 * invite the one question nobody can answer. Weight comes from lib/bytes.mjs, measured on
 * the page we actually photographed. See its header.
 *
 * NEVER A REFUSAL. This is a supporting number; the surface measurement is the product. A
 * PSI that times out, 429s or returns something unrecognisable leaves `psi.json` unwritten
 * and a note behind, and the audit carries on.
 *
 * The limitation worth knowing: a lab run is a simulation on hardware that is not the
 * visitor's, and two runs of the same URL differ. It is a signal, not a stopwatch.
 */
import {readFileSync} from 'node:fs';

/** Google's own default is mobile; ours is not. See the header. */
export const STRATEGY = 'desktop';

/** Measured at 21.5s and 27.5s on the two probes, so the ceiling is generous. */
export const PSI_TIMEOUT_MS = 90000;

/** One retry, and only for the answers that mean "ask again", never for a 4xx that will not change. */
export const PSI_ATTEMPTS = 2;
export const PSI_BACKOFF_MS = 3000;

export const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * The key, environment first and then the file, for the reason lib/vision.mjs gives: the
 * Craft job on Forge has the variable and a git worktree has no `craft/.env` at all.
 *
 * NULL RATHER THAN A THROW, which is the difference between this and the model's key.
 * Without an Anthropic key there is no measurement and the run should stop; without this
 * one there is simply no speed section, and an audit that refuses to run because a
 * supporting number is unavailable has its priorities backwards.
 */
export function psiKey(envPath = 'craft/.env') {
    if (process.env.GOOGLE_CLOUD_KEY) {
        return process.env.GOOGLE_CLOUD_KEY;
    }
    try {
        return (readFileSync(envPath, 'utf8').match(/^GOOGLE_CLOUD_KEY\s*=\s*"?([^"\n\r]+)"?/m) ?? [])[1] ?? null;
    } catch {
        return null;
    }
}

/** Ask again, or accept the answer? A 429 or a 5xx may change; a 400 will not. */
export const worthRetrying = (status) => status === null || status === 429 || (status >= 500 && status < 600);

const ms = (audit) => (typeof audit?.numericValue === 'number' ? Math.round(audit.numericValue) : null);

/**
 * The seven lab metrics, all of which were present on both probe sites.
 *
 * `cls` is deliberately NOT rounded to an integer — it is a unitless score between 0 and 1
 * where 0.1 is the difference between good and needs-work, and `Math.round` would report
 * every page on the web as a flat 0.
 */
export function labMetrics(audits = {}) {
    return {
        fcpMs: ms(audits['first-contentful-paint']),
        lcpMs: ms(audits['largest-contentful-paint']),
        tbtMs: ms(audits['total-blocking-time']),
        cls: typeof audits['cumulative-layout-shift']?.numericValue === 'number'
            ? Number(audits['cumulative-layout-shift'].numericValue.toFixed(3))
            : null,
        speedIndexMs: ms(audits['speed-index']),
        ttiMs: ms(audits.interactive),
        serverResponseMs: ms(audits['server-response-time']),
    };
}

/** Lighthouse's audit ids, as labMetrics names them. */
const LAB_KEYS = {
    'first-contentful-paint': 'fcpMs',
    'largest-contentful-paint': 'lcpMs',
    'total-blocking-time': 'tbtMs',
    'cumulative-layout-shift': 'cls',
    'speed-index': 'speedIndexMs',
};

/**
 * The points out of 100 each metric cost, read off Lighthouse's own weights and scores.
 *
 * GOOGLE'S PASS LINE IS NOT THE SCORE'S CURVE. furious-squad.com's Largest Contentful Paint
 * is 1,781ms, under the 2,500ms Core Web Vitals line, and Lighthouse's desktop curve still
 * scores it 0.7 — at a weight of 25 that is 7.5 of the 8 points the page was missing. Without
 * this a report can only say every metric passed and the score is 92, which explains nothing.
 *
 * READ, NOT HARD-CODED: the weights move between Lighthouse versions, and the response says
 * which ones it used. Null when the response does not carry them.
 */
export function pointsLost(lh) {
    const refs = lh?.categories?.performance?.auditRefs;
    if (!Array.isArray(refs)) {
        return null;
    }
    const weighted = refs.filter((r) => r.weight > 0);
    const total = weighted.reduce((sum, r) => sum + r.weight, 0);
    const lost = {};
    for (const r of weighted) {
        const score = lh.audits?.[r.id]?.score;
        if (typeof score === 'number' && total > 0) {
            lost[LAB_KEYS[r.id] ?? r.id] = Number(((r.weight / total) * 100 * (1 - score)).toFixed(1));
        }
    }

    return Object.keys(lost).length ? lost : null;
}

/**
 * A PSI payload reduced to what a report needs, or an error with a reason.
 *
 * `finalUrl` IS KEPT FOR THE SAME REASON meta.landedUrl is: PSI follows redirects too, and
 * a speed score attributed to the wrong domain is wrong in a way no rounding can fix.
 * dept.agency answers 301 to dept.global, and PSI will happily report on the destination.
 *
 * A missing performance score is an error rather than a zero. Zero is a real score and a
 * page that scored it should say so; a page whose score we could not read should not be
 * reported as the worst possible one.
 */
export function parsePsi(payload) {
    const lh = payload?.lighthouseResult;
    if (!lh) {
        return {error: 'no lighthouseResult in the response'};
    }
    const score = lh.categories?.performance?.score;
    if (typeof score !== 'number') {
        return {error: 'no performance score in the response'};
    }

    return {
        requestedUrl: payload.id ?? null,
        finalUrl: lh.finalUrl ?? lh.finalDisplayedUrl ?? null,
        strategy: lh.configSettings?.formFactor ?? STRATEGY,
        lighthouseVersion: lh.lighthouseVersion ?? null,
        fetchedAt: lh.fetchTime ?? null,
        score: Math.round(score * 100),
        lab: labMetrics(lh.audits),
        lost: pointsLost(lh),
    };
}

/**
 * Fetch and reduce, or `{error}`. Never throws.
 *
 * The whole 889KB response is parsed and thrown away; about 1KB of it survives into
 * `psi.json`. Keeping the rest would be twenty megabytes of JSON per hundred audits that
 * nothing reads.
 */
/**
 * The Lighthouse errors that are the PAGE's doing — it hung, painted nothing, or its own
 * server refused the document. Google names them in the message ("Lighthouse returned
 * error: PAGE_HUNG. …"), and a visitor's browser meets the same wall, so the report
 * scores speed 0 for them. pinpointhq.com: PAGE_HUNG on mobile and desktop, its Rive
 * animations holding the main thread (see RAF_GATE in lib/capture.mjs).
 */
export const PAGE_FAILURES = ['PAGE_HUNG', 'NO_FCP', 'NO_LCP', 'FAILED_DOCUMENT_REQUEST', 'ERRORED_DOCUMENT_REQUEST', 'NOT_HTML', 'DNS_FAILURE', 'INSECURE_DOCUMENT_REQUEST'];

/**
 * Whose failure a PageSpeed error is, which decides what the report does with it:
 *
 *   'page'    Lighthouse named a page failure (PAGE_FAILURES). Speed 0/10.
 *   'unclear' Google gave up without saying why — "Something went wrong", a 5xx, no answer
 *             in time. Speed 0/10, and the entry asks Jon to re-verify before sending.
 *   'ours'    the key, the quota, a refused request, or an answer we could not read.
 *             Nothing about the site; no score, and the entry says what to fix.
 *
 * @param {number|null} status  the HTTP status, null when there was no response at all
 * @param {string} message
 * @returns {{failure: 'page'|'unclear'|'ours', code: string|null}}
 */
export function failureKind(status, message) {
    const code = (String(message).match(/Lighthouse returned error: ([A-Z_]+)/) ?? [])[1] ?? null;
    if (code && PAGE_FAILURES.includes(code)) return {failure: 'page', code};
    if (status === null || status >= 500) return {failure: 'unclear', code};

    return {failure: 'ours', code};
}

export async function fetchPsi(url, opts = {}) {
    const key = opts.key ?? psiKey(opts.envPath);
    if (!key) {
        return {error: 'no GOOGLE_CLOUD_KEY in the environment or in craft/.env', failure: 'ours', code: null};
    }
    const strategy = opts.strategy ?? STRATEGY;
    const attempts = opts.attempts ?? PSI_ATTEMPTS;
    const timeoutMs = opts.timeoutMs ?? PSI_TIMEOUT_MS;
    const fetcher = opts.fetch ?? fetch;
    const sleep = opts.sleep ?? ((n) => new Promise((r) => setTimeout(r, n)));

    const query = new URLSearchParams({url, strategy, category: 'performance', key});
    let last = 'the request never completed';
    let lastStatus = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let status = null;
        try {
            const res = await fetcher(`${ENDPOINT}?${query}`, {signal: AbortSignal.timeout(timeoutMs)});
            status = res.status;
            if (res.ok) {
                const reduced = parsePsi(await res.json());

                // A 200 we could not read is our parsing, never the page's.
                return reduced.error ? {error: reduced.error, failure: 'ours', code: null} : reduced;
            }
            // The body carries Google's own explanation — a disabled API, a bad key, an
            // exhausted quota — and it is the difference between a five-minute fix and an
            // afternoon. Bounded, because it is a page from a server we do not control.
            last = `PageSpeed answered ${status}: ${String(await res.text().catch(() => '')).slice(0, 200)}`;
            lastStatus = status;
        } catch (e) {
            last = `PageSpeed did not answer: ${e.message}`;
            lastStatus = null;
        }
        if (attempt < attempts && worthRetrying(status)) {
            await sleep((opts.backoffMs ?? PSI_BACKOFF_MS) * attempt);
            continue;
        }
        break;
    }

    return {error: last, ...failureKind(lastStatus, last)};
}
