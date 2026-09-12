/**
 * NAV PANEL
 *
 * The header burger opens the site menu (_components/nav-panel.twig) — the page
 * slab, turned white, with the way around the site on it.
 *
 * A native <dialog>, but opened with show() rather than showModal(). Modal would
 * hand over the top layer, Escape and a focus trap for nothing — except that the top
 * layer sits above EVERY z-index, which buries the header: the logo, the Contact
 * button, and the burger you need to press to close the thing. So the panel is
 * non-modal and sits just under the header (z-index lg vs xl), and Escape and the
 * click-outside are wired here instead.
 *
 * The click listener runs in the CAPTURE phase for the same reason the contact
 * panel's does: page-transition.js would otherwise see the click first and start
 * warping out of a page we aren't leaving.
 *
**/

// The fade, matched to $c-nav-panel-ms in _nav-panel.scss. close() is deferred by
// this long so the transition actually plays — a bare close() removes the element
// from the top layer immediately and there is nothing left to animate.
import {FLAG} from './page-transition.js';

const FADE_MS = 260;

export function mountNavPanel() {
    const panel = document.querySelector('[data-nav-panel]');
    const toggle = document.querySelector('[data-nav-toggle]');
    if (!panel || !toggle || typeof panel.showModal !== 'function') return () => {};

    let closing = false;

    // How wide the scrollbar is, measured BEFORE the lock takes it away.
    //
    // `.is-nav-open` puts `overflow: hidden` on the root, which removes the scrollbar —
    // and on a machine with classic (space-taking) scrollbars that widens the viewport
    // by ~15px. The header is `fixed` while the panel is open, spanning that viewport,
    // so its right-hand end — the Contact button and this very burger — jumps sideways
    // by exactly the scrollbar's width on open and back again on close.
    //
    // `scrollbar-gutter: stable` on <html> does NOT cover this. It reserves the gutter
    // while the page SCROLLS; the moment overflow goes hidden the reservation goes with
    // it (measured: 485px → 500px, identical to `auto`). `overflow: clip` behaves the
    // same. There is no CSS-only answer, so the width is measured and handed to CSS.
    const lockGutter = () => {
        const gutter = window.innerWidth - document.documentElement.clientWidth;
        document.documentElement.style.setProperty('--nav-scrollbar', `${gutter}px`);
    };

    // Take the entry animation off each item once it has played.
    //
    // The animation needs `fill-mode: both` to hold an item hidden through its stagger
    // delay, but that also means it keeps applying its end value forever — leaving the
    // element animation-controlled, and WebKit leaving it on a compositor layer. Fast
    // hovering then re-rasterises that layer through the colour transition, and a
    // layer re-rastered mid-flight paints its text at the wrong scale: one item in the
    // list renders huge for a moment. Slow hovering never provokes it.
    //
    // .is-arrived hands the final state back to plain CSS so the layer can be dropped.
    // Idempotent, and harmless if animationend never fires (reduced motion sets
    // `animation: none`, so there is nothing to end and nothing to correct).
    const items = [...panel.querySelectorAll('.c-nav-panel__item')];
    const onItemArrived = (e) => {
        if (e.animationName && e.target.classList) e.target.classList.add('is-arrived');
    };
    items.forEach((el) => el.addEventListener('animationend', onItemArrived));

    const open = () => {
        // Replay the entry on every open, so the stagger isn't spent after the first.
        items.forEach((el) => el.classList.remove('is-arrived'));
        lockGutter(); // before the class, or the scrollbar is already gone
        panel.show();
        document.documentElement.classList.add('is-nav-open');
        toggle.setAttribute('aria-expanded', 'true');
        // Focus the panel itself, not the first link: a pointer user hasn't asked to
        // be put on a link, and a visible ring on one would read as a selection.
        // Keyboard users tab straight into the list from here.
        panel.querySelector('.c-nav-panel__inner')?.focus();
    };

    const close = () => {
        if (closing) return;
        closing = true;
        panel.removeAttribute('open'); // starts the fade; the element is still rendered
        document.documentElement.classList.remove('is-nav-open');
        // Cleared with the class, not after the fade: the lock lifts the moment the
        // class goes, so the compensation has to lift with it or it overshoots the
        // other way for the length of the animation.
        document.documentElement.style.removeProperty('--nav-scrollbar');
        // Set here, NOT left to the `close` event below. Removing the attribute has
        // already closed a non-modal dialog, so the deferred close() is a no-op that
        // fires no event — and the button was left saying aria-expanded="true" after
        // every Escape and every click-outside. The listener stays as the safety net
        // for anything that closes the panel without coming through here.
        toggle.setAttribute('aria-expanded', 'false');
        window.setTimeout(() => {
            panel.close();
            closing = false;
        }, FADE_MS);
    };

    const onToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.open ? close() : open();
    };

    // Escape (and anything else that closes a dialog behind our back) has to leave
    // the button telling the truth about what it does next.
    const onClose = () => {
        document.documentElement.classList.remove('is-nav-open');
        document.documentElement.style.removeProperty('--nav-scrollbar');
        toggle.setAttribute('aria-expanded', 'false');
        closing = false;
    };

    // Escape is free with showModal() and ours here, since this panel is non-modal.
    //
    // There is deliberately NO click-outside handler. It had one, and it was wrong in
    // both directions: the panel is full-bleed, so there is no page left showing to
    // click "outside" onto — and the only things that ARE outside it are the header
    // and any other overlay. That made a click inside the contact panel (opened from
    // the header, over the top of this one) close the nav behind it, which is what a
    // "send me a message" click was doing. The X and Escape are the ways out.
    const onKey = (e) => {
        if (e.key !== 'Escape' || !panel.open) return;
        // Escape belongs to whatever is on TOP. The contact panel opens over this one
        // (modal, so the browser closes it on Escape itself) — and without this guard
        // the same keypress closed the nav underneath at the same moment, leaving the
        // contact panel floating over a page the visitor never navigated back to.
        if ([...document.querySelectorAll('dialog[open]')].some((d) => d !== panel)) {
            return;
        }
        close();
    };

    // A link click navigates STRAIGHT AWAY, skipping page-transition's warp-out.
    //
    // Two problems it solves, both caused by that warp running under an open panel:
    //
    //   · The panel used to close here, which uncovered the page being left for the
    //     whole 320ms of the warp — the flash of the old page.
    //   · Leaving the panel open fixed that but hid the header instead. The warp
    //     transforms `body > .b-wrap`, which makes it a stacking context, so
    //     everything inside — the header at z-index xl included — composites as one
    //     layer beneath this panel, whatever its z-index. The logo, Contact and the
    //     close cross all dropped out the instant the warp began.
    //
    // Neither is worth solving cleverly, because the warp-out is INVISIBLE here: the
    // panel covers the viewport it plays on. It buys nothing and costs 320ms. So the
    // click is taken before page-transition's document listener sees it — its first
    // guard is `e.defaultPrevented`, so preventing the default makes it stand down —
    // and we set the handshake flag ourselves so the page we land on still warps IN,
    // which does happen in view.
    const onPanelNavigate = (e) => {
        // Anything the browser should handle its own way: modified clicks (new tab,
        // download), middle clicks, a link aimed at another target.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            return;
        }
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) {
            return;
        }

        let url;
        try {
            url = new URL(a.getAttribute('href'), location.href);
        } catch (err) {
            return; // unparseable — let the browser deal with it
        }
        if (url.origin !== location.origin) return;

        e.preventDefault();
        try {
            sessionStorage.setItem(FLAG, '1');
        } catch (err) { /* private mode — the next page just won't warp in */ }
        location.href = url.href;
    };

    toggle.addEventListener('click', onToggle, true);
    panel.addEventListener('close', onClose);
    panel.addEventListener('click', onPanelNavigate);
    document.addEventListener('keydown', onKey);

    return () => {
        items.forEach((el) => el.removeEventListener('animationend', onItemArrived));
        toggle.removeEventListener('click', onToggle, true);
        panel.removeEventListener('close', onClose);
        panel.removeEventListener('click', onPanelNavigate);
        document.removeEventListener('keydown', onKey);
    };
}
