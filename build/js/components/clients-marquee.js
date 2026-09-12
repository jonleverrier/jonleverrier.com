// Clients logo marquee setup — shared by the Jonson answer rail (jonson-ask.js)
// and the static content page (app.js).
//
// Takes one "run" of logos, repeats it until it spans the strip (so there's
// never a gap), duplicates that run, then sets a duration proportional to its
// width for a constant scroll speed and starts it (.is-ready). Idempotent: it
// tags the element so a second call is a no-op.

import {mountCaseStudyMarquee} from './case-study-marquee.js';
import {revealPictures} from './picture.js';

const SPEED = 20; // px per second — a slow, gentle drift

// Defaults describe the clients strip; the case-study marquee passes its own
// selectors and duration property so both share this fill/clone/speed logic
// rather than keeping two copies of it in step.
const CLIENTS = {
    track: '.c-clients__track',
    run: '.c-clients__items',
    durationProp: '--c-clients-duration',
    speed: SPEED,
};

// The case-study strip runs when EITHER holds:
//
//   POINTER   a real pointer and room for more than one 538px slide (a laptop)
//   WIDE      any device at least 64em across, pointer or not (a tablet in landscape)
//
// The second was added because `pointer: fine` alone excluded every tablet at every
// width — an iPad reports `hover: none` and `pointer: coarse`, so a 1024px landscape
// screen with room for three slides still got the stack. The condition was stricter
// than the interaction needs: this marquee is driven by POINTER events, which touch
// raises too, so dragging it already worked on a touchscreen — nothing was reaching
// the code to try.
//
// Two queries rather than one `or`, because both files have to agree and the SCSS
// side expresses the same thing in plain comma-separated conditions.
//
// MUST MATCH the media query in _case-study.scss, which stacks the cards everywhere
// else — if the two disagree you get either an animation running on a column, or
// every case study twice down that column from the cloned run.
const MARQUEE_MQ = '(hover: hover) and (pointer: fine) and (min-width: 48em)';
const MARQUEE_WIDE_MQ = '(min-width: 64em)';
const REDUCED_MQ = '(prefers-reduced-motion: reduce)';

const caseStudyMarquees = new Set();
// element => its teardown fn, so a strip is only ever mounted once and can be
// unwound cleanly when the viewport drops below the breakpoint.
const teardowns = new Map();
// Set-up guard lives here, NOT on the element as a data attribute. thread-memory
// snapshots the thread's innerHTML, so a DOM flag gets restored while the JS state
// (the clone, the duration) does not — the guard then blocks a rebuild and the strip
// sits there dead. A WeakSet can't survive serialisation, which is exactly right.
const built = new WeakSet();
let watching = false;

const marqueeAllowed = () =>
    (window.matchMedia(MARQUEE_MQ).matches || window.matchMedia(MARQUEE_WIDE_MQ).matches)
    && !window.matchMedia(REDUCED_MQ).matches;

// Build or unwind every registered case-study strip to match the current viewport.
// Runs on content arrival AND whenever the query flips, so resizing across the
// breakpoint works in both directions — enlarge and the strip starts moving, narrow
// and it unwinds back to a clean stack rather than leaving the clone behind.
function syncCaseStudyMarquees() {
    const allowed = marqueeAllowed();
    caseStudyMarquees.forEach((el) => {
        if (!el.isConnected) {
            caseStudyMarquees.delete(el); // answer was wiped or replaced
            return;
        }
        if (allowed) {
            if (!teardowns.has(el)) {
                const off = mountCaseStudyMarquee(el);
                // Null means it had no layout yet; the retries below try again.
                if (off) {
                    teardowns.set(el, off);
                    // The build cloned the cards: develop every picture in the
                    // strip now, clones included (see revealPictures).
                    revealPictures(el, {immediate: true});
                }
            }
        } else if (teardowns.has(el)) {
            teardowns.get(el)();
            teardowns.delete(el);
        }
    });
}

function watchViewport() {
    if (watching) return;
    watching = true;
    window.matchMedia(MARQUEE_MQ).addEventListener('change', syncCaseStudyMarquees);
    window.matchMedia(MARQUEE_WIDE_MQ).addEventListener('change', syncCaseStudyMarquees);
    window.matchMedia(REDUCED_MQ).addEventListener('change', syncCaseStudyMarquees);

    // Rebuild on any width change, not just crossing the breakpoint. How many copies
    // of the run are needed depends on the strip's width: the seamless -50% loop only
    // works if one run is at least as wide as the visible strip, so with few case
    // studies a wider window needs more copies than a narrower one. Built once at the
    // old width, the run stays short and the loop shows a gap instead of repeating.
    // Tearing down to pristine markup and rebuilding re-runs the fill for the width
    // that's actually there now.
    let lastWidth = window.innerWidth;
    let debounce = 0;
    window.addEventListener('resize', () => {
        if (window.innerWidth === lastWidth) return; // ignore height-only changes
        lastWidth = window.innerWidth;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            // Unmount first: how many copies of the run are needed depends on the
            // strip's width, so a marquee built at the old width has a run that's
            // now the wrong length and its loop would show a gap.
            teardowns.forEach((off, el) => { off(); teardowns.delete(el); });
            syncCaseStudyMarquees();
        }, 200);
    }, {passive: true});
}

// Set up every marquee inside `scope` — both kinds. Called wherever content
// arrives: on load, when an answer streams in, and after a thread is restored.
export function setupMarquees(scope) {
    if (!scope) return;

    scope.querySelectorAll('.c-clients').forEach((el) => setupMarquee(el));

    // Register regardless of the current viewport — a strip that arrives while the
    // window is narrow still has to start moving if the window is later widened.
    scope.querySelectorAll('.c-case-studies--marquee').forEach((el) => caseStudyMarquees.add(el));
    watchViewport();
    syncCaseStudyMarquees();
    // Panels are composed off-screen and revealed as a piece, so the first attempt
    // usually measures zero and mountCaseStudyMarquee returns null. Retry until it
    // takes; each call is a no-op once a strip is mounted.
    [60, 200, 500, 1200, 3000].forEach((d) => setTimeout(syncCaseStudyMarquees, d));
}

// Put a strip back exactly as it was rendered: the fill loop and the loop clone both
// add children, so restoring the original markup is the only reliable undo.
export function teardownMarquee(marquee, options = {}) {
    const {track: trackSel, durationProp} = {...CLIENTS, ...options};
    const track = marquee.querySelector(trackSel);
    if (!track || !built.has(marquee)) return;

    if (typeof marquee._marqueePristine === 'string') {
        track.innerHTML = marquee._marqueePristine;
    }
    marquee.classList.remove('is-ready');
    marquee.style.removeProperty(durationProp);
    built.delete(marquee);
}

export function setupMarquee(marquee, options = {}) {
    const {track: trackSel, run: runSel, durationProp, speed} = {...CLIENTS, ...options};

    const track = marquee.querySelector(trackSel);
    const run = track && track.querySelector(runSel);
    if (!run || built.has(marquee)) return;

    // Snapshot the untouched markup so teardownMarquee can restore it. Both the fill
    // loop and the loop clone below add children, so counting them back off is
    // fiddlier and easier to get wrong than just keeping the original.
    if (typeof marquee._marqueePristine !== 'string') {
        marquee._marqueePristine = track.innerHTML;
    }

    const items = Array.from(run.children);
    if (!items.length) return;

    const build = () => {
        // Fill the run so it's at least as wide as the visible strip. This is what
        // makes the -50% loop seamless: the track is two identical runs, so when the
        // first scrolls fully out of view the second must already cover the strip. A
        // run narrower than the strip leaves a visible gap on every cycle — the case
        // with only a couple of case studies on a wide screen.
        let guard = 0;
        while (run.scrollWidth < marquee.clientWidth && guard < 50) {
            items.forEach((item) => run.appendChild(item.cloneNode(true)));
            guard += 1;
        }

        const runWidth = run.scrollWidth;
        track.appendChild(run.cloneNode(true)); // second run → seamless -50% loop

        marquee.style.setProperty(durationProp, Math.max(8, runWidth / speed) + 's');
        marquee.classList.add('is-ready');
        // Marked built only on SUCCESS. Setting it up front meant that if the
        // deferred attempts below all expired before the panel had layout, the strip
        // was flagged done without ever being built and no later call could rescue
        // it — a permanently dead marquee.
        built.add(marquee);
    };

    // Measure only once the strip actually has layout. Panels are composed off-screen
    // and revealed as a whole, so at this point everything here often measures 0 —
    // which silently pinned the duration to its 8s floor and made the fill loop a
    // no-op.
    const ready = () => marquee.clientWidth > 0 && run.scrollWidth > 0;
    if (ready()) {
        build();
        return;
    }

    // Any previous watchers for this element are stale — a fresh call means another
    // chance to build (new content arrived, or the viewport crossed the breakpoint).
    if (marquee._marqueeWatch) marquee._marqueeWatch();

    let done = false;
    const attempt = () => {
        if (done || built.has(marquee) || !ready()) return false;
        done = true;
        build();
        return true;
    };

    // A ResizeObserver catches the reveal without any call site needing to know when
    // it happens. But it's the only trigger, so if it never fires the strip stays
    // dead — which is exactly what happens in some environments. The timed retries
    // are the backstop; whichever wins, `done` stops the other.
    let ro = null;
    const timers = [];
    const stop = () => {
        if (ro) ro.disconnect();
        timers.forEach(clearTimeout);
        marquee._marqueeWatch = null;
    };
    marquee._marqueeWatch = stop;

    if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
            if (attempt()) stop();
        });
        ro.observe(marquee);
    }

    [60, 200, 500, 1200, 3000].forEach((delay) => {
        timers.push(setTimeout(() => {
            if (attempt()) stop();
        }, delay));
    });
}
