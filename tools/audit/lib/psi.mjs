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
    };
}

/**
 * Fetch and reduce, or `{error}`. Never throws.
 *
 * The whole 889KB response is parsed and thrown away; about 1KB of it survives into
 * `psi.json`. Keeping the rest would be twenty megabytes of JSON per hundred audits that
 * nothing reads.
 */
export async function fetchPsi(url, opts = {}) {
    const key = opts.key ?? psiKey(opts.envPath);
    if (!key) {
        return {error: 'no GOOGLE_CLOUD_KEY in the environment or in craft/.env'};
    }
    const strategy = opts.strategy ?? STRATEGY;
    const attempts = opts.attempts ?? PSI_ATTEMPTS;
    const timeoutMs = opts.timeoutMs ?? PSI_TIMEOUT_MS;
    const fetcher = opts.fetch ?? fetch;
    const sleep = opts.sleep ?? ((n) => new Promise((r) => setTimeout(r, n)));

    const query = new URLSearchParams({url, strategy, category: 'performance', key});
    let last = 'the request never completed';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let status = null;
        try {
            const res = await fetcher(`${ENDPOINT}?${query}`, {signal: AbortSignal.timeout(timeoutMs)});
            status = res.status;
            if (res.ok) {
                const reduced = parsePsi(await res.json());

                return reduced.error ? {error: reduced.error} : reduced;
            }
            // The body carries Google's own explanation — a disabled API, a bad key, an
            // exhausted quota — and it is the difference between a five-minute fix and an
            // afternoon. Bounded, because it is a page from a server we do not control.
            last = `PageSpeed answered ${status}: ${String(await res.text().catch(() => '')).slice(0, 200)}`;
        } catch (e) {
            last = `PageSpeed did not answer: ${e.message}`;
        }
        if (attempt < attempts && worthRetrying(status)) {
            await sleep((opts.backoffMs ?? PSI_BACKOFF_MS) * attempt);
            continue;
        }
        break;
    }

    return {error: last};
}
