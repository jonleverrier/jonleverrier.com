// Play a case study Lottie block while it's on screen, pause it when it isn't.
//
// The markup ships as an empty box with the composition's aspect ratio (see the
// lottie block in case-content.twig). Nothing is fetched at page load: the player
// (~70KB gz, SVG renderer with expressions) and the JSON itself are both pulled in
// when the block comes within a viewport's height of the screen, so pages without a
// Lottie never pay for the library and pages with one pay for it late.
//
// Playback follows the video block's rules: it runs only while enough of the box is
// visible AND the tab is focused, and comes back from the top rather than mid-loop.
// `data-lottie-loop` (the block's Loop Animation? switch) decides what the end of
// the animation means: with it, it cycles; without, it plays through once and holds
// its last frame until it has left the screen, then plays again on its return.
//
// Reduced motion: the animation is still loaded, but parked on its first frame — a
// still of the work is worth showing, a loop is what was asked not to be.

const SEL = '[data-lottie]';

// Enough of the box on screen to be worth playing — same bar as the video block.
const THRESHOLD = 0.25;

// Start fetching this far before the box scrolls in, so it's ready on arrival.
const PREFETCH_MARGIN = '100% 0px';

let lib = null;
const loadLib = () => {
    lib ??= import('lottie-web/build/player/esm/lottie_svg.min.js').then((m) => m.default ?? m);
    return lib;
};

function setup(el) {
    if (el._lottieBlock) return;

    const path = el.dataset.lottie;
    if (!path) return;
    const loop = el.hasAttribute('data-lottie-loop');

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let anim = null;
    let requested = false; // the library + JSON fetch is under way or done
    let disposed = false;
    let near = false;      // inside the prefetch margin
    let onScreen = false;  // at least THRESHOLD of it visible
    let finished = false;  // a one-shot has played through; cleared on leaving the screen

    const sync = () => {
        if (!anim) {
            if (near && !requested) {
                requested = true;
                fetchAndBuild();
            }
            return;
        }
        if (reduced) return; // parked on frame 0 by DOMLoaded below

        if (onScreen && !document.hidden) {
            // Coming back to it starts it from the top, like the video: gated on
            // `isPaused` so a slow crawl across the threshold, which re-fires the
            // observer mid-play, doesn't snap it back under the visitor. A one-shot
            // that has finished stays on its last frame — the player pauses itself
            // at the end, so without `finished` the same crawl would replay it.
            if (anim.isPaused && !finished) anim.goToAndPlay(0, true);
        } else {
            if (!anim.isPaused) anim.pause();
            if (!onScreen) finished = false; // off screen: the next arrival plays again
        }
    };

    const fetchAndBuild = async () => {
        let lottie;
        try {
            lottie = await loadLib();
        } catch {
            el.classList.add('is-failed');
            return;
        }
        if (disposed) return;

        anim = lottie.loadAnimation({
            container: el,
            renderer: 'svg',
            loop,
            autoplay: false,
            path,
            rendererSettings: {
                preserveAspectRatio: 'xMidYMid meet',
                progressiveLoad: true,
            },
        });
        anim.addEventListener('DOMLoaded', () => {
            el.classList.add('is-ready');
            if (reduced) anim.goToAndStop(0, true);
            sync();
        });
        anim.addEventListener('data_failed', () => { el.classList.add('is-failed'); });
        // Fires only when not looping — a loop never completes.
        anim.addEventListener('complete', () => { finished = true; });
    };

    // Two observers, because they answer different questions against different
    // areas. "Near enough to fetch" is measured against the viewport plus a
    // margin. "Visible enough to play" has to be measured against the real
    // viewport: an observer with a margin reports its ratio against the EXPANDED
    // area, so a block sitting just below the fold — the first block on a case
    // study, under the hero — reads as fully visible to it and plays unseen. A
    // one-shot then finishes before anyone scrolls to it and holds its last frame.
    const ioNear = new IntersectionObserver(([e]) => {
        near = e.isIntersecting;
        sync();
    }, {rootMargin: PREFETCH_MARGIN});
    ioNear.observe(el);

    const ioPlay = new IntersectionObserver(([e]) => {
        onScreen = e.isIntersecting && e.intersectionRatio >= THRESHOLD;
        sync();
    }, {threshold: [0, THRESHOLD]});
    ioPlay.observe(el);

    // A hidden tab still runs a playing animation; the observer can't see that.
    const onVisibility = () => sync();
    document.addEventListener('visibilitychange', onVisibility);

    el._lottieBlock = () => {
        disposed = true;
        ioNear.disconnect();
        ioPlay.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        if (anim) anim.destroy();
        anim = null;
        el.classList.remove('is-ready');
        el._lottieBlock = null;
    };
}

/** Wire every [data-lottie] inside `root`. Idempotent. */
export function mountLottieBlocks(root = document) {
    if (!root) return () => {};

    const scope = root === document ? document : root;
    scope.querySelectorAll(SEL).forEach(setup);

    return () => {
        scope.querySelectorAll(SEL).forEach((el) => {
            if (el._lottieBlock) el._lottieBlock();
        });
    };
}
