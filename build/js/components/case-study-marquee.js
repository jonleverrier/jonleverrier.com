// Case study catalogue marquee — drifts on its own, and you can grab it and spin it.
//
// The logo strip next door is a pure CSS animation, which is cheap but immovable:
// a keyframed transform has no position you can take hold of, so there's nothing to
// drag. Here one number owns the position instead, and both the drift and the pointer
// write to it — so a drag doesn't fight the animation, it IS the animation.
//
// The track holds two identical runs, so wrapping the offset modulo one run's width
// makes it endless in both directions with no seam and no re-layout.
//
// Everything still moves via translate3d, so it stays on the compositor exactly as
// the CSS version did.

const DRIFT = 34;        // px per second, idle
const DIRECTION = 1;     // 1 drifts the cards right to left, -1 left to right
const FRICTION = 0.94;   // momentum decay per frame after a throw
const MIN_FLICK = 0.02;  // px/ms — below this, momentum has finished
const DRAG_SLOP = 4;     // px of movement before it counts as a drag, not a click

export function mountCaseStudyMarquee(marquee) {
    const track = marquee.querySelector('.c-case-studies__track');
    const run = track && track.querySelector('.c-case-studies__items');
    if (!run) return null;

    const items = Array.from(run.children);
    if (!items.length) return null;

    // Snapshot the untouched markup BEFORE any cloning, so teardown can put the strip
    // back exactly as it was rendered. Without this, narrowing the window past the
    // stack breakpoint tore down the animation but left every clone in the DOM — and
    // the stacked column then showed each case study three or four times over. The
    // clients strip solves this the same way (see teardownMarquee).
    const pristine = track.innerHTML;

    // Fill so one run covers the strip, then clone it. Both are needed for the wrap:
    // when the first run has scrolled fully out, the second must already cover the
    // visible width or you see a gap on every lap.
    let guard = 0;
    while (run.scrollWidth < marquee.clientWidth && guard < 50) {
        items.forEach((item) => run.appendChild(item.cloneNode(true)));
        guard += 1;
    }
    const runWidth = run.scrollWidth;
    if (!runWidth) return null; // no layout yet — caller retries
    track.appendChild(run.cloneNode(true));

    // Start one card in, so the lead card sits in the SECOND slot rather than the
    // first. Drifting right to left, slot 1 is the one about to leave — so a strip
    // starting at 0 puts the card the ordering worked hardest to choose (the same
    // client's other work, then the featured picks) in the position with the least
    // time left on screen. Offsetting by a card buys it a full slot of travel before
    // it goes anywhere.
    //
    // Expressed as a NEGATIVE offset that apply() wraps back into range: the two runs
    // are identical, so shifting the track a card to the right and showing the clone's
    // lead card is the same picture, with no seam to hide.
    const gap = parseFloat(getComputedStyle(run).columnGap || getComputedStyle(run).gap) || 0;
    const leadWidth = items[0] ? items[0].getBoundingClientRect().width + gap : 0;

    let x = -leadWidth;     // current offset, wrapped into [0, runWidth) by apply()
    let velocity = 0;       // px/ms, from a throw
    let dragging = false;
    let pointerId = null;
    let lastX = 0;
    let lastT = 0;
    let moved = 0;          // total px travelled this gesture
    let hovering = false;
    let raf = 0;
    let prev = 0;

    const apply = () => {
        // Wrap rather than grow: keeps the number small and the loop seamless.
        x = ((x % runWidth) + runWidth) % runWidth;
        track.style.transform = `translate3d(${-x}px, 0, 0)`;
    };

    // Paint the starting offset before the first rAF, so the strip is never seen at 0.
    apply();

    const frame = (now) => {
        const dt = prev ? Math.min(now - prev, 64) : 16; // clamp after a tab switch
        prev = now;

        if (dragging) {
            // Position comes straight from the pointer; nothing to integrate.
        } else if (Math.abs(velocity) > MIN_FLICK) {
            x -= velocity * dt;                 // coast
            velocity *= Math.pow(FRICTION, dt / 16);
        } else if (!hovering) {
            velocity = 0;
            x += (DIRECTION * DRIFT * dt) / 1000; // idle drift
        }

        apply();
        raf = requestAnimationFrame(frame);
    };

    // Every listener that can END a drag lives on the window, added for the duration
    // of the gesture. Bound to the strip instead, a release outside it — or one the
    // browser routes elsewhere after pointer capture is lost — never arrives, and the
    // strip stays glued to the cursor with no way out. That's the failure this guards
    // against, so keep the teardown symmetrical with the setup.
    const addDragListeners = () => {
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        window.addEventListener('lostpointercapture', endDrag);
        window.addEventListener('blur', endDragNow);
        document.addEventListener('visibilitychange', endDragNow);
    };

    const removeDragListeners = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
        window.removeEventListener('lostpointercapture', endDrag);
        window.removeEventListener('blur', endDragNow);
        document.removeEventListener('visibilitychange', endDragNow);
    };

    function onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        // Every slide is an <a>, and dragging a link starts the browser's OWN
        // drag-and-drop — it grabs the pointer, shows a link ghost, and the pointermove
        // stream stops arriving. The strip then simply doesn't move, in either
        // direction. preventDefault stops that before it starts.
        //
        // It does NOT stop the click: `draggable = false` and the dragstart guard below
        // already kill the native drag on their own, so this is belt and braces — but
        // cancelling pointerdown also suppresses the compatibility mouse events, and
        // in Chrome that took the click with it. Cards were unclickable.
        //
        // NO setPointerCapture either. Capture retargets the whole pointer sequence at
        // the capturing element, so Chrome dispatched the click at the strip instead of
        // the card inside it — the anchor never saw it and never navigated. It bought
        // nothing anyway: every listener that ends a drag is on `window`, which already
        // catches a release anywhere on the page.
        dragging = true;
        moved = 0;
        velocity = 0;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastT = e.timeStamp;
        marquee.classList.add('is-dragging');
        addDragListeners();
    }

    function onPointerMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;

        // Safety net: if the mouse button is no longer held, the pointerup was lost
        // somewhere (a release over browser chrome, a devtools pause, an alert). Ending
        // here means the worst case is one stale frame rather than a permanent drag.
        if (e.pointerType === 'mouse' && e.buttons === 0) {
            endDragNow();
            return;
        }

        const dx = e.clientX - lastX;
        const dt = Math.max(1, e.timeStamp - lastT);
        x -= dx;                       // content follows the hand
        velocity = dx / dt;            // px/ms, for the throw
        moved += Math.abs(dx);
        lastX = e.clientX;
        lastT = e.timeStamp;
        apply();
    }

    function endDragNow() {
        if (!dragging) return;
        dragging = false;
        marquee.classList.remove('is-dragging');
        pointerId = null; // nothing to release — the pointer was never captured
        removeDragListeners();
    }

    function endDrag(e) {
        if (!dragging) return;
        // No pointerId on blur/visibilitychange; a mismatched one is another pointer.
        if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
        // A stale velocity from a pause mid-drag would fling it on release.
        if (e && e.timeStamp !== undefined && e.timeStamp - lastT > 120) velocity = 0;
        endDragNow();
    }

    // A drag that ends over a card must not open it. Capture phase, so this runs
    // before the link's own handling, and only for the click that ends the gesture.
    const onClickCapture = (e) => {
        if (moved > DRAG_SLOP) {
            e.preventDefault();
            e.stopPropagation();
            moved = 0;
        }
    };

    const onEnter = () => { hovering = true; };
    const onLeave = () => { hovering = false; };

    // Belt and braces against the native link drag: `draggable=false` on every card
    // stops it being offered at all, and the dragstart guard catches anything that
    // still tries (an image inside the card, a browser that ignores the attribute).
    const disableNativeDrag = () => {
        marquee.querySelectorAll('a, img').forEach((el) => { el.draggable = false; });
    };
    disableNativeDrag();
    const onDragStart = (e) => e.preventDefault();
    marquee.addEventListener('dragstart', onDragStart);

    marquee.addEventListener('pointerdown', onPointerDown);
    marquee.addEventListener('click', onClickCapture, true);
    marquee.addEventListener('pointerenter', onEnter);
    marquee.addEventListener('pointerleave', onLeave);

    marquee.classList.add('is-ready', 'is-draggable');
    raf = requestAnimationFrame(frame);

    return () => {
        cancelAnimationFrame(raf);
        endDragNow(); // also detaches the window listeners if a drag is in flight
        marquee.removeEventListener('dragstart', onDragStart);
        marquee.removeEventListener('pointerdown', onPointerDown);
        marquee.removeEventListener('click', onClickCapture, true);
        marquee.removeEventListener('pointerenter', onEnter);
        marquee.removeEventListener('pointerleave', onLeave);
        marquee.classList.remove('is-ready', 'is-draggable', 'is-dragging');
        track.style.transform = '';
        // Restore the pristine markup, dropping the fill copies and the wrap clone.
        // Order matters: the listeners above are unbound first, and they live on
        // `marquee`/`track` — which survive this — not on the children being replaced.
        track.innerHTML = pristine;
    };
}
