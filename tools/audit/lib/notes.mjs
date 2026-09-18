/**
 * NOTES
 *
 * Everything about a run that a percentage taken from it would otherwise hide, in a
 * shape something downstream can branch on.
 *
 *   node --test tools/audit/test/notes.test.mjs
 *
 * WHY THIS EXISTS. Every warning this tool produces — a WebGL hero that never drew, a
 * region below the deepest captured element, a truncated screenshot, a consent wall left
 * standing, the scroll cap, a capture that ended on a different URL — reached stdout and
 * stderr and stopped there. THE CRAFT JOB WILL IMPORT lib/, NOT THE CLIs, so the entire
 * honesty layer was terminal text that nothing downstream could see, on a tool whose
 * whole argument is that a confident wrong number is worse than an honest unknown. That
 * argument only held for someone watching a terminal.
 *
 * THE SHAPE, and why it is this one:
 *
 *   {
 *     metaRead: true,
 *     conditions: {
 *       scrollCapHit: {effect: 'unmeasured', message: '…', facts: {…}},
 *     },
 *   }
 *
 *   - `conditions` is KEYED BY CODE, not a list. A consumer asking "did this happen"
 *     writes `'scrollCapHit' in notes.conditions`, a code cannot appear twice, and there
 *     is no parallel array of codes to fall out of step with the entries.
 *   - `effect` is the small closed set below, and it is the axis a report BRANCHES on:
 *     each value names a different thing to do about the number, not a severity to
 *     print. Adding a condition means choosing one of these, which is the useful
 *     question to be forced to answer.
 *   - `facts` is machine-readable and RAW — the real URL, the real gap in pixels.
 *   - `message` is the human sentence, and it is the same one stderr prints. It has been
 *     through printable(), so it is safe to put on a terminal; `facts` has not.
 *   - `metaRead` is the distinction the whole file exists for: an empty `conditions`
 *     with `metaRead: true` means NOTHING WAS WRONG, and with `metaRead: false` it means
 *     WE COULD NOT TELL. A missing meta.json used to be a clean-looking exit 0.
 *
 * The limitation worth knowing: this reports only what phase 1 recorded. Content behind
 * `prefers-reduced-motion` is absent from every capture and nothing detects it, so its
 * absence is not in here — a silence this file cannot break.
 */
import {webglWarning} from './webgl.mjs';
import {shotTruncationWarning, unrenderedWarning, paintLimitWarning, PAINT_LIMIT_PX} from './unrendered.mjs';
import {printable} from './printable.mjs';
import {sameUrl} from './sameurl.mjs';

/**
 * What a condition does to the number, and therefore what a report must do about it.
 *
 *   unmeasured   part of the page is missing from the image. Decline for that region;
 *                never report it as empty space.
 *   attribution  the percentages may belong to a different page than the one asked for.
 *   included     something is inside the measurement that a reader would want named.
 *   unknown      we could not check. Not the same as "nothing was wrong".
 */
export const EFFECTS = ['unmeasured', 'attribution', 'included', 'unknown'];

/**
 * The conditions that apply to a run, from its meta.json.
 *
 * `meta` is the parsed record, or null when there is none — `reason` then says whether
 * it was missing or unreadable, because "you never captured this" and "your capture
 * record is corrupt" are different problems with the same shape.
 */
export function runNotes(meta, reason = 'missing') {
    const conditions = {};
    const add = (code, effect, message, facts = {}) => {
        conditions[code] = {effect, message, facts};
    };

    if (!meta || typeof meta !== 'object') {
        add(
            'metaMissing',
            'unknown',
            reason === 'unreadable'
                ? 'meta.json could not be read, so nothing about this capture could be checked — '
                    + 'whether the page drew, whether the screenshot is the whole page, or even which page it is'
                : 'there is no meta.json beside this tree, so nothing about the capture could be checked — '
                    + 'whether the page drew, whether the screenshot is the whole page, or even which page it is',
            {reason},
        );

        return {metaRead: false, conditions};
    }

    // WHETHER THIS IS A PAGE AT ALL comes before which page it is. webreality.co.uk
    // answers a headless browser with a CloudFront 403, and the capture recorded that as
    // an ordinary success: two blocks, area conserved, exit 0. Percentages of an error
    // page are not a weaker measurement, they are a measurement of something else.
    if (typeof meta.httpStatus === 'number' && (meta.httpStatus < 200 || meta.httpStatus >= 300)) {
        add(
            'httpError',
            'attribution',
            `the server answered ${meta.httpStatus}, so this is an error page rather than the site — `
                + 'a CDN or firewall blocking the crawler looks exactly like this. Nothing measured here '
                + 'describes the page that was asked for',
            {status: meta.httpStatus},
        );
    }

    // WHICH PAGE THIS IS A MEASUREMENT OF comes next: a percentage attributed to the
    // wrong domain is wrong in a way no other note here can make up for.
    if (meta.capturedUrl && meta.url && !sameUrl(meta.capturedUrl, meta.url)) {
        add(
            'wrongPage',
            'attribution',
            `these blocks are of ${printable(meta.capturedUrl)}, not the ${printable(meta.url)} that was requested`,
            {requested: meta.url, captured: meta.capturedUrl},
        );
    }

    const truncated = shotTruncationWarning(meta);
    if (truncated) {
        add('shotTruncated', 'unmeasured', truncated, {
            pageHeight: meta.fullHeight,
            imageHeight: meta.image?.height ?? null,
            missing: meta.fullHeight - (meta.image?.height ?? 0),
        });
    }

    // A DIFFERENT CONDITION FROM shotTruncated, and the reason that one could not see it:
    // the PNG is the full height and the rows below the paint limit are background, so
    // the two heights agree and nothing looks wrong. Only the page height against the
    // limit reveals it.
    const painted = paintLimitWarning(meta);
    if (painted) {
        add('paintLimit', 'unmeasured', painted, {
            pageHeight: meta.fullHeight,
            paintLimit: PAINT_LIMIT_PX,
            missing: meta.fullHeight - PAINT_LIMIT_PX,
        });
    }

    // Neither of the next two reached any warning function before: `scrollCapHit` was
    // printed once by the capture CLI and referenced nowhere else, and an undismissed
    // consent wall was recorded and never mentioned again.
    if (meta.scrollCapHit === true) {
        add(
            'scrollCapHit',
            'unmeasured',
            'the scroll loop hit its cap before the page stopped growing, so this may be an '
                + 'infinite-scroll page measured over an arbitrary prefix of itself',
            {fullHeight: meta.fullHeight ?? null},
        );
    }

    // ONLY WHEN A BANNER WAS ACTUALLY THERE. `consentDismissed: false` used to mean both
    // "there was a wall and we could not get past it" and "this page has no cookie
    // banner", so this note fired on liquidlight.co.uk and vaiie.com — neither of which
    // has one — announcing that their measurements were "largely a measurement of the
    // wall". On most of the web, in other words. A warning that fires on the ordinary
    // case teaches its reader to skip the one that matters.
    if (meta.consentDismissed === false && meta.consentBannerSeen === true) {
        add(
            'consentNotDismissed',
            'included',
            'a consent banner was found and not dismissed, so it is part of what was measured. That is '
                + 'the right answer — it is real surface area — but a full-screen wall means this is '
                + 'largely a measurement of the wall'
                + (meta.consentNavigatedAway === true ? ', and a consent click moved the page and was undone' : ''),
            {navigatedAway: meta.consentNavigatedAway === true, via: meta.consentVia ?? null},
        );
    }

    const blind = webglWarning(meta.webgl);
    if (blind) {
        add('webglBlind', 'unmeasured', blind, {
            requested: meta.webgl?.requested ?? [],
            draws: meta.webgl?.draws ?? 0,
            renderer: meta.webgl?.renderer ?? null,
        });
    }

    const unrendered = unrenderedWarning(meta);
    if (unrendered) {
        add('unrenderedGap', 'unmeasured', unrendered, {
            gap: meta.heightGap?.gap ?? null,
            fraction: meta.heightGap?.fraction ?? null,
            contentBottom: meta.heightGap?.contentBottom ?? null,
            likelyCause: meta.heightGap?.likelyCause ?? null,
        });
    }

    return {metaRead: true, conditions};
}

/** The codes that apply, in the order they were added. */
export const noteCodes = (notes) => Object.keys(notes?.conditions ?? {});

/** Does any condition mean part of the page is missing from the measurement? */
export const anyUnmeasured = (notes) =>
    Object.values(notes?.conditions ?? {}).some((c) => c.effect === 'unmeasured');
