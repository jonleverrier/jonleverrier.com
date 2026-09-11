/**
 * PAUSE-OFFSCREEN
 *
 * Pauses continuous CSS animations while their element is off-screen, so the
 * infinite ones (the clients marquee scroll, the method shimmer) don't keep the
 * compositor — and the battery — busy when they're not visible. Adds/removes
 * `is-anim-paused`; the CSS sets `animation-play-state: paused` under it.
 *
 * A single shared IntersectionObserver (with a margin, so it resumes a touch
 * before it scrolls in — no visible cold-start). Works for markup present on
 * load and for nodes injected later (Jonson responses).
 */

const CLASS = 'is-anim-paused';
let io = null;

function ensure() {
    if (io) return io;
    if (!('IntersectionObserver' in window)) return null;
    io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            e.target.classList.toggle(CLASS, !e.isIntersecting);
        }
    }, {rootMargin: '200px'}); // resume just before it enters view
    return io;
}

// Observe every `.c-clients` / `.c-method` within `root` (the root itself counts,
// so this also handles a freshly-injected response node).
export function pauseOffscreenWithin(root = document) {
    const obs = ensure();
    if (!obs) return;
    const sel = '.c-clients, .c-method';
    if (root.matches && root.matches(sel)) obs.observe(root);
    if (root.querySelectorAll) {
        for (const el of root.querySelectorAll(sel)) obs.observe(el);
    }
}

export function mountPauseOffscreen() {
    pauseOffscreenWithin(document);
    return function dispose() {
        if (io) { io.disconnect(); io = null; }
    };
}
