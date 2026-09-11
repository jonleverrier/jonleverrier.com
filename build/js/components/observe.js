/**
 * OBSERVE
 *
 * Reveal-on-scroll behaviour, declarative. Any element with the `js-observe`
 * class is watched; the first time it scrolls into view, `is-inview` is added
 * and it's unobserved. Works for markup present on load (mountObserver) and for
 * elements injected later (observeWithin — e.g. the Jonson context rail).
 *
 * Per-element override:
 *   data-observe-class → class to add instead of `is-inview`
 *
**/

const HOOK = 'js-observe';
// Reveal-on-scroll for content blocks: fires when the block's TOP crosses a line
// 85% of the way down the viewport (a bottom root margin of -15%, any
// intersection), rather than when a fifth of it is showing. A tall prose block
// under `js-observe`'s 20% threshold would sit hidden until the reader had
// scrolled a long way into it; this reveals it as it arrives, like the fade-up
// on a well-tuned marketing page.
//
// The root also extends a long way ABOVE the viewport. An observer only reports
// intersection CHANGES, and a block can go from below the reveal line to above the
// viewport with no frame in between — a wheel fling, an anchor jump, a restored
// scroll position on back-navigation. Measured: one 2000px jump left the About
// page's summary hidden for good, a blank slab where the words should be. With
// the root reaching up past anything scrollable, a block that's been scrolled past
// still intersects it, so it reveals instead of staying blank.
const HOOK_REVEAL = 'js-reveal';
const REVEAL_ROOT_MARGIN = '100000px 0px -15% 0px';
let io = null;
let ioReveal = null;

function reveal(el) {
    el.classList.add(el.dataset.observeClass || 'is-inview');
}

function ensureObserver() {
    if (io) return io;
    if (!('IntersectionObserver' in window)) return null;
    io = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            reveal(entry.target);
            obs.unobserve(entry.target);
        }
    }, {threshold: 0.2});
    return io;
}

function ensureRevealObserver() {
    if (ioReveal) return ioReveal;
    if (!('IntersectionObserver' in window)) return null;
    ioReveal = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            reveal(entry.target);
            obs.unobserve(entry.target);
        }
    }, {rootMargin: REVEAL_ROOT_MARGIN, threshold: 0});
    return ioReveal;
}

function observe(el, which = ensureObserver) {
    const obs = which();
    if (!obs) { reveal(el); return; } // no IO support → reveal immediately
    obs.observe(el);
}

// Observe every `.js-observe` within `root` — the root element itself counts,
// so this works on a freshly-injected node as well as the whole document.
export function observeWithin(root = document) {
    if (root.classList && root.classList.contains(HOOK)) observe(root);
    if (root.classList && root.classList.contains(HOOK_REVEAL)) observe(root, ensureRevealObserver);
    if (root.querySelectorAll) {
        for (const el of root.querySelectorAll('.' + HOOK)) observe(el);
        for (const el of root.querySelectorAll('.' + HOOK_REVEAL)) observe(el, ensureRevealObserver);
    }
}

// Observe everything already in the document. Returns a disposer.
export function mountObserver() {
    observeWithin(document);
    return function dispose() {
        if (io) { io.disconnect(); io = null; }
        if (ioReveal) { ioReveal.disconnect(); ioReveal = null; }
    };
}
