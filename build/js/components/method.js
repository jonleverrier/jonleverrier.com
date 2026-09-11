/**
 * METHOD ("How I can help") — the horizontal, paged project timeline.
 *
 * Markup comes from _components/method.twig, in two places: injected into a Jonson
 * answer for the [[method]] marker, and shipped in the About page. One delegated
 * handler on `document` (mounted from app.js) covers both — arrows, numbered nodes,
 * the left/right keys when the timeline is focused, and a re-sync on resize. The
 * thread must NOT add its own copy, or every press advances two phases (the same
 * rule as the testimonials slider).
 *
 * methodApply() is exported for the answer path, which rests each new timeline on
 * its first phase the moment it lands (see jonson-ask.js revealAnswer).
 */

const SEL = '.c-method';
const MULTI = '.c-method.has-multiple';

// Move the method timeline to a phase (clamped): slide the full-width track by
// one viewport per step (like the testimonials slider), mark the active phase +
// node, grow the fill to the active node's centre, and point the arrows.
export function methodApply(slider, index) {
    const viewport = slider.querySelector('.c-method__viewport');
    const track = slider.querySelector('.c-method__track');
    const phases = [...slider.querySelectorAll('.c-method__phase')];
    if (!viewport || !track || !phases.length) return;
    const last = phases.length - 1;
    index = Math.max(0, Math.min(last, index));

    slider.dataset.index = String(index);
    // Final node = goal reached: the line fills fully and the pulse makes one
    // last left→right sweep instead of looping (see .is-complete in _method.scss).
    const complete = index >= last;
    const wasComplete = slider.classList.contains('is-complete');
    slider.classList.toggle('is-complete', complete);
    // `is-burning` brackets the fill's 1.2s burn, and is what keeps the final node
    // on its own compositor layer above the burning line — for the burn only. Left
    // on permanently, that layer made Safari re-snap the track by a pixel whenever a
    // pill was hovered on the last slide (see _method.scss). Cleared on the burn's
    // animationend, with a timer as the fallback for when no animation runs
    // (reduced motion sets it to none, so no end event ever fires).
    clearTimeout(slider._burnTimer);
    if (complete && !wasComplete) {
        slider.classList.add('is-burning');
        const fill = slider.querySelector('.c-method__line--fill');
        const stop = () => {
            clearTimeout(slider._burnTimer);
            slider.classList.remove('is-burning');
            if (fill) fill.removeEventListener('animationend', onEnd);
        };
        const onEnd = (e) => { if (e.animationName === 'c-method-burn') stop(); };
        if (fill) fill.addEventListener('animationend', onEnd);
        slider._burnTimer = setTimeout(stop, 1500);
    } else if (!complete) {
        slider.classList.remove('is-burning');
    }

    // GEOMETRY IN FRACTIONS, LANDING ON WHOLE DEVICE PIXELS.
    //
    // The phase pitch is fractional (a rem-based gap on top of the measure) and so
    // is the centring gutter. This used to step by `offsetLeft`, which rounds to
    // whole CSS pixels — so every slide landed the active phase about half a pixel
    // from where it rests at index 0, and the error grew with each phase. Layout
    // never showed it (getBoundingClientRect is stable) but Safari did: while the
    // track's transform transitions, its text lives on a compositor layer; when the
    // transition ends the layer is dropped and the text is re-rasterised in page
    // coordinates, and text rasterised at x.5 does not match text rasterised at x.0
    // — a 1px settle-jump at the end of every slide, and the softness on the way.
    //
    // So: measure with getBoundingClientRect, minus whatever transform is on the
    // track right now (this runs mid-transition on a fast click), which gives every
    // phase's UNTRANSFORMED position exactly. Then translate the target phase to
    // where phase 0 rests, snapped to the device-pixel grid, so the text lands on a
    // whole pixel and rasterises the same on and off the layer. The motion in
    // between is fractional either way — only where it stops matters.
    const dpr = window.devicePixelRatio || 1;
    const current = (() => {
        const t = getComputedStyle(track).transform;
        return (!t || t === 'none') ? 0 : new DOMMatrixReadOnly(t).m41;
    })();
    const left = (el) => el.getBoundingClientRect().left - current; // untransformed
    const home = Math.round(left(phases[0]) * dpr) / dpr;
    const shift = home - left(phases[index]); // 0 (or a sub-pixel nudge) at index 0
    track.style.transform = `translateX(${shift}px)`;
    phases.forEach((p, i) => {
        p.classList.toggle('is-active', i === index);
        p.toggleAttribute('aria-hidden', i !== index);
    });

    // Grow the fill from the left edge to the active node (in track coords —
    // each node sits at its phase's left edge). On the first phase this leaves a
    // lead-in segment from the edge up to node 01; it extends further right as
    // you advance. Same untransformed measurement as above, so the line ends
    // under the node's real centre rather than a rounded one.
    const fill = slider.querySelector('.c-method__line--fill');
    const trackLeft = left(track);
    const nodeCentre = (i) => {
        const n = phases[i].querySelector('.c-method__node');
        return (n ? left(n) + n.offsetWidth / 2 : left(phases[i])) - trackLeft;
    };
    if (fill) {
        fill.style.left = '0px';
        // On the final node the goal is reached — run the fill all the way (CSS
        // extends it across the last gutter to the frame edge, see _method.scss).
        fill.style.width = index >= last
            ? '100%'
            : `${Math.max(0, nodeCentre(index))}px`;
    }

    const prev = slider.querySelector('.c-method__cycle--prev');
    const next = slider.querySelector('.c-method__cycle--next');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= last;
}

// The track offset and the fill are pixel values, so after a width change the
// current phase is re-applied without animating.
function resync(root) {
    root.querySelectorAll(MULTI).forEach((slider) => {
        const track = slider.querySelector('.c-method__track');
        const fill = slider.querySelector('.c-method__line--fill');
        if (track) track.style.transition = 'none';
        if (fill) fill.style.transition = 'none';
        methodApply(slider, Number(slider.dataset.index || 0));
        if (track) void track.offsetWidth; // flush so the jump isn't animated
        if (track) track.style.transition = '';
        if (fill) fill.style.transition = '';
    });
}

/** Wire every method timeline under `root` (default: the document). Idempotent. */
export function mountMethod(root = document) {
    if (!root || root._methodMounted) return () => {};
    root._methodMounted = true;

    const onClick = (e) => {
        const slider = e.target.closest(MULTI);
        if (!slider) return;
        const index = Number(slider.dataset.index || 0);
        const node = e.target.closest('.c-method__node');
        if (node) methodApply(slider, Number(node.dataset.index || 0));
        else if (e.target.closest('.c-method__cycle--next')) methodApply(slider, index + 1);
        else if (e.target.closest('.c-method__cycle--prev')) methodApply(slider, index - 1);
    };

    const onKeydown = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const slider = e.target.closest(MULTI);
        if (!slider) return;
        e.preventDefault();
        methodApply(slider, Number(slider.dataset.index || 0) + (e.key === 'ArrowRight' ? 1 : -1));
    };

    let raf = null;
    const onResize = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; resync(root); });
    };

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize);

    // Timelines already in the page (About) rest on their first phase now; ones
    // injected later (answers) are rested by the code that injects them.
    root.querySelectorAll(SEL).forEach((slider) => methodApply(slider, 0));

    return function dispose() {
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        window.removeEventListener('resize', onResize);
        if (raf) cancelAnimationFrame(raf);
        root._methodMounted = false;
    };
}
