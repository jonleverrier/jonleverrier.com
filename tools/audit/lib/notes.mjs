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
 * The limitation worth knowing: most of this reports only what phase 1 recorded, so a
 * condition phase 1 did not see is not in here. The exception is the one that used to be
 * the example — content behind `prefers-reduced-motion`, absent from every capture —
 * which `contentNotPainted` now finds by comparing the DOM against the pixels rather
 * than by asking the capture. See lib/painted.mjs.
 */
import {webglWarning} from './webgl.mjs';
import {shotTruncationWarning, unrenderedWarning, paintLimitWarning, PAINT_LIMIT_PX} from './unrendered.mjs';
import {printable} from './printable.mjs';
import {overlayWarning} from './overlay.mjs';
import {sameUrl} from './sameurl.mjs';
import {errorPageEvidence, errorPageWarning} from './errorpage.mjs';
import {blankRegionWarning, transparentWarning, unpaintedWarning} from './painted.mjs';

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
 *
 * `rects` is the same list phase 2 segments with; `unpainted`, `blank` and `transparent`
 * are the three results of lib/painted.mjs over the finished tree. All of them are
 * OPTIONAL for the same reason rects are optional in the segmenter: a caller may have
 * nothing but a PNG. The conditions that need them simply do not fire, which is the
 * honest answer — not a claim that nothing was wrong.
 */
export function runNotes(meta, reason = 'missing', rects = null, unpainted = null, blank = null, transparent = null, overlays = null) {
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

    // THE SAME QUESTION AS httpError, ASKED OF A PAGE THAT ANSWERED 200. Bot mitigation
    // usually presents as a soft error page: lloydsbank.com serves one with a status of
    // 200, and it segmented into 12 blocks with area conserved and no notes at all. A
    // NOTE AND NOT A REFUSAL, because the evidence is circumstantial where a 4xx is not —
    // see errorpage.mjs for what this is willing to claim and what it gives up.
    const softError = errorPageWarning(rects);
    if (softError) {
        add('errorPageLikely', 'attribution', softError, errorPageEvidence(rects));
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

    // A THIRD CONDITION THAT REACHED A TERMINAL AND NOTHING ELSE, which is the mistake
    // the two above were written to correct and which was made again for late arrivals.
    // The phase 1 CLI prints "N MORE ARRIVED AFTER THE DECISION AND MAY REPEAT" to its
    // own stdout; the Craft job imports lib/ and never sees it, and blocks.json says
    // nothing. natwest.com is the page that shows what that costs: its pinned census
    // found 13 candidates early, decided NONE of them, and recorded 15 arrivals after
    // the decision — and its "Chat to Cora" widget is painted four times down the
    // stitched image, once per slice it was present for, while `notes` reads `none`.
    //
    // UNMEASURED RATHER THAN INCLUDED, and the distinction is the whole point. A consent
    // wall we failed to dismiss is real surface area seen once, so it is `included`. This
    // is one element counted several times, which is not a measurement of anything: the
    // repeats inflate whatever category the widget lands in, by a factor nobody can see.
    const late = meta.capture?.pinned?.lateArrivals ?? 0;
    if (late > 0) {
        add(
            'lateArrivals',
            'unmeasured',
            `${late} element${late === 1 ? '' : 's'} appeared after the capture had decided which pinned `
                + 'elements to hide, so any of them that holds the viewport is painted once per slice it '
                + 'was present for. Where that happens a single element is counted several times',
            {
                lateArrivals: late,
                decided: meta.capture.pinned.decided ?? null,
                earlyPinned: meta.capture.pinned.earlyPinned ?? null,
                slices: meta.capture.slices ?? null,
            },
        );
    }

    // CHROME THE DOM CENSUS COULD NOT REACH, found in the pixels instead. natwest.com's
    // chat widget is rendered by LivePerson into something no walk can see — not the light
    // DOM, not an open shadow root, and its two LivePerson iframes are 0x0 — so the pinned
    // census correctly reports nothing pinned while the widget is painted into all eight
    // slices. See lib/overlay.mjs.
    //
    // UNMEASURED, because what an overlay covers was never photographed. Painting the
    // repeats out would be inventing pixels, and counting them as content would count one
    // element eight times.
    const overlaid = overlayWarning(overlays, meta.image?.height ?? meta.fullHeight ?? 0);
    if (overlaid) {
        add('pinnedOverlay', 'unmeasured', overlaid, {regions: overlays});
    }

    const blind = webglWarning(meta.webgl);
    if (blind) {
        add('webglBlind', 'unmeasured', blind, {
            requested: meta.webgl?.requested ?? [],
            draws: meta.webgl?.draws ?? 0,
            renderer: meta.webgl?.renderer ?? null,
        });
    }

    // THE SILENCE THE HEADER OF THIS FILE USED TO DECLARE UNBREAKABLE. Content behind
    // `prefers-reduced-motion` is absent from every capture, and the claim was that
    // nothing could detect it. The DOM and the pixels contradict each other where it
    // happens, and lib/painted.mjs measures the contradiction per block.
    const unpaintedRegions = unpaintedWarning(unpainted);
    if (unpaintedRegions) {
        add('contentNotPainted', 'unmeasured', unpaintedRegions, {blocks: unpainted});
    }

    // THE SAME MISSING PIXELS WITH A CAUSE ATTACHED, and a separate code because it is a
    // separate thing to do about it. `contentNotPainted` says content should have painted
    // and did not; this says content was still behind an `opacity: 0` ancestor when the
    // page was censused, which is a reveal the capture did not reach rather than a render
    // that failed. Conflating them had one consequence in particular: 89 elements inside
    // one transparent container on boondmanager.com could carry a block over the
    // contradiction threshold on their own.
    const stillTransparent = transparentWarning(transparent);
    if (stillTransparent) {
        add('contentTransparent', 'unmeasured', stillTransparent, {blocks: transparent});
    }

    // A REGION EMPTY IN BOTH RECORDS, which the check above cannot see by design: where
    // the DOM says nothing is there either, there is no contradiction to find. alchemy.je
    // and tpagency.com each carry a black void across nearly half the page and came
    // through with no notes at all. See blankRegions.
    const voids = blankRegionWarning(blank);
    if (voids) {
        add('blankRegion', 'unmeasured', voids, {blocks: blank});
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
