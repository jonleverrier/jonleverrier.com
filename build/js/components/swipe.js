/**
 * SWIPE — a horizontal finger gesture, for sliders that otherwise need their
 * prev/next buttons.
 *
 * Shared by the method timeline and the testimonial slider. It was written inline
 * in the first of those; the second wanted the identical forty lines, including
 * the parts that are easy to get subtly wrong, so it lives here instead.
 *
 * TOUCH AND PEN ONLY. A mouse already has the buttons and the arrow keys, and
 * claiming a mouse drag would fight text selection in the prose these sliders sit
 * among. `(hover: hover)` is not the test — a laptop with a touchscreen should have
 * both — the pointer TYPE of the actual gesture is.
 *
 * DECIDED ON pointerup, from the total travel. Nothing tracks the finger, so there
 * is no half-dragged state to settle or rubber-band, and the slider's own
 * transition does the movement. That is a deliberate trade: the gesture doesn't
 * feel like dragging paper, but it costs no per-frame work on a phone and cannot
 * leave a track parked between two slides.
 *
 * The caller must set `touch-action: pan-y` on the element. Without it the browser
 * scrolls the page a few pixels before deciding the gesture was ours, and the swipe
 * is stolen part-way through. It belongs in CSS, where the browser reads it before
 * the gesture starts — preventDefault in a move handler is always too late.
 */

const SWIPE_MIN = 44;    // px of travel before it is a swipe rather than a tap
const SWIPE_BIAS = 1.3;  // and how much more horizontal than vertical
const CLICK_GRACE = 400; // ms after a swipe in which a trailing click is ignored

/**
 * onSwipe(root, selector, handler) -> dispose
 *
 * Calls handler(element, direction) where direction is +1 for a swipe to the LEFT
 * (drag the content back to reveal what's next, as a page moves) and -1 for right.
 */
export function onSwipe(root, selector, handler) {
    if (!root || typeof handler !== 'function') return () => {};

    let swipe = null;
    let swipedAt = 0;

    const onPointerDown = (e) => {
        if (e.pointerType === 'mouse') return;
        const el = e.target.closest && e.target.closest(selector);
        if (!el) return;
        swipe = { el, id: e.pointerId, x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e) => {
        if (!swipe || e.pointerId !== swipe.id) return;
        const { el, x, y } = swipe;
        swipe = null;
        const dx = e.clientX - x;
        const dy = e.clientY - y;
        if (Math.abs(dx) < SWIPE_MIN) return;                 // a tap, or a twitch
        if (Math.abs(dx) < Math.abs(dy) * SWIPE_BIAS) return; // they were scrolling
        swipedAt = Date.now();
        handler(el, dx < 0 ? 1 : -1);
    };

    const onPointerCancel = () => { swipe = null; };

    // A swipe that starts on a dot, a node or a cycle button still ends in a click,
    // which would then jump to whatever happened to be under the finger. Swallowed
    // in the CAPTURE phase at the root, so it never reaches the slider's own click
    // handler — that handler needs no knowledge of this file.
    //
    // Stamped rather than a flag that needs clearing: if no click follows, it
    // expires on its own.
    const onClickCapture = (e) => {
        if (Date.now() - swipedAt >= CLICK_GRACE) return;
        if (!(e.target.closest && e.target.closest(selector))) return;
        e.stopPropagation();
        e.preventDefault();
    };

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerCancel);
    root.addEventListener('click', onClickCapture, true);

    return function dispose() {
        root.removeEventListener('pointerdown', onPointerDown);
        root.removeEventListener('pointerup', onPointerUp);
        root.removeEventListener('pointercancel', onPointerCancel);
        root.removeEventListener('click', onClickCapture, true);
    };
}
