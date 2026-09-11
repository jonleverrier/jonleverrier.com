// Custom cursor for the case study cards — a badge that follows the pointer while
// you're over a card, telling you the whole tile is a link into the work.
//
// Not `cursor: url(...)`: that can't animate, and browsers cap it around 32px (and
// silently fall back to the default above it). A single fixed element following the
// pointer can be any size and animates like anything else.
//
// ONE element for the page, not one per card. The cards stream in with answers, so
// per-card elements would mean creating and destroying them constantly; this hooks
// delegated pointer events instead and moves the same node around.
//
// Mouse only. `(hover: hover) and (pointer: fine)` excludes touch (no pointer to
// follow) and coarse pointers like a TV remote or a stylus-only tablet. Nothing is
// added to the DOM at all on those devices — the element is created lazily on the
// first card hover, so a phone never pays for this.
//
// Everything animated here is transform + opacity, so it stays on the compositor.
// will-change IS set on this one, unlike the card's hover states: this element moves
// continuously for as long as it's visible, which is exactly the case the hint is
// for (see the note at _method.scss:141 about not applying it permanently).
//
// Deliberately NO easing on the follow. A lerp toward the pointer looks smooth in
// isolation but reads as lag next to the system cursor it's replacing — and being
// per-frame rather than per-second, it also felt tighter on a 120Hz display than a
// 60Hz one. The badge tracks the pointer exactly; the only motion is the reveal.

const CARD = '.c-case-study';

// Set on <html> when the pointer has scrolled off a card without moving. Chrome keeps
// :hover matching the element that WAS under the cursor until the next real mouse
// move, so scrolling away leaves the card hovered — badge showing, page blurred, over
// nothing. JS can't clear a :hover, so the hover-driven rules are gated on the absence
// of this class instead (see _case-study.scss).
const STALE = 'has-stale-hover';

export function mountCaseStudyCursor() {
    // Bail entirely on touch/coarse pointers.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        return () => {};
    }

    let el = null;      // the badge, created on first use
    let visible = false;
    let lastX = 0;      // last known pointer position, for the post-scroll re-test
    let lastY = 0;
    let queued = false; // rAF throttle for the scroll check

    const build = () => {
        el = document.createElement('div');
        el.className = 'c-cursor';
        el.setAttribute('aria-hidden', 'true'); // decorative; the link is announced already
        el.innerHTML =
            '<svg class="c-cursor__icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
            '<path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="3" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';
        document.body.appendChild(el);
        document.documentElement.classList.add('has-card-cursor'); // hides the native one
        return el;
    };

    // Written straight from the pointer event, with no smoothing and no rAF in
    // between. An interpolated follow (each frame closing a fraction of the gap)
    // trails the pointer by several frames and reads as lag — this is meant to sit
    // where a cursor sits. Coalescing through rAF would also cost up to a frame, so
    // the event handler writes the transform itself.
    //
    // Cheap enough to do per event: it only ever touches `transform`, which is
    // compositor-only, so there's no layout or paint to repeat.
    const place = (e) => {
        el.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    };

    const onMove = (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        // A real move is what Chrome recomputes :hover on, so whatever it now says is
        // true again. Clear the override here rather than waiting for pointerover —
        // the pointer may have moved back onto the same card, which fires no over event.
        document.documentElement.classList.remove(STALE);
        if (visible && el) place(e);
    };

    const show = (e) => {
        if (!el) build();
        place(e); // land on the pointer rather than flying in from 0,0
        lastX = e.clientX;
        lastY = e.clientY;
        visible = true;
        el.classList.add('is-visible');
    };

    const hide = () => {
        visible = false;
        if (el) el.classList.remove('is-visible');
    };

    // Delegated, because cards arrive with streamed answers. pointerover/out fire
    // for descendants too, so compare the card the pointer came from with the one
    // it went to — otherwise moving across the logo or title flickers the badge.
    const onOver = (e) => {
        const card = e.target.closest && e.target.closest(CARD);
        if (!card) return;
        const from = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(CARD);
        if (from === card) return; // moved within the same card
        show(e);
    };

    const onOut = (e) => {
        const card = e.target.closest && e.target.closest(CARD);
        if (!card) return;
        const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(CARD);
        if (to === card) return; // still inside the same card
        hide();
    };

    // Scrolling moves the page under a stationary pointer, so the card can leave the
    // cursor without a single pointer event firing — no pointerout, and :hover stays
    // put. Re-test what's actually under the pointer and, if it isn't a card, drop the
    // badge and flag the stale hover so the blur rules stop matching.
    //
    // rAF-throttled: elementFromPoint forces a style/layout flush, and a fling scroll
    // fires far more often than a frame. Once it has gone stale `visible` is false, so
    // the rest of the scroll costs nothing at all.
    const check = () => {
        queued = false;
        const under = document.elementFromPoint(lastX, lastY);
        if (under && under.closest && under.closest(CARD)) return;
        hide();
        document.documentElement.classList.add(STALE);
    };

    const onScroll = () => {
        if (!visible || queued) return;
        queued = true;
        requestAnimationFrame(check);
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointermove', onMove, {passive: true});
    window.addEventListener('scroll', onScroll, {passive: true});

    return () => {
        document.removeEventListener('pointerover', onOver);
        document.removeEventListener('pointerout', onOut);
        document.removeEventListener('pointermove', onMove);
        window.removeEventListener('scroll', onScroll);
        if (el) el.remove();
        document.documentElement.classList.remove('has-card-cursor');
        document.documentElement.classList.remove(STALE);
    };
}
