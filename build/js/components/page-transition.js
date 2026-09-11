// Page-to-page zoom transition (JS-driven).
//
// Replaces native cross-document view transitions, which are Chrome-only and, in
// dev, capture the incoming page before it's styled (our CSS is injected by JS,
// not render-blocking) — so the zoom never shows. This works in every browser,
// in dev and prod.
//
// Departure: an internal link click warps the current page out (.is-page-leaving)
// before navigating. Arrival: the next page warps in (.is-page-entering), which
// is added synchronously in _includes/page/head.twig from a sessionStorage flag
// so it's set before first paint (no flash). Keyframes (c-warp-out / c-warp-in)
// live inline in that head partial, render-blocking, for the same reason.

// Exported so the nav panel can set it when it bypasses the warp-OUT but still
// wants the next page to warp IN (see nav-panel.js).
export const FLAG = 'jonson-nav';   // sessionStorage handshake between the two pages
const OUT_MS = 320;          // must match c-warp-out in head.twig

export function mountPageTransition() {
    const root = document.documentElement;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Arrival — the warp-in is pure CSS (class already set in the head). Just tidy
    // the class away once it's done so it doesn't linger on the element.
    //
    // The animation runs on `body > .b-wrap`, not on <html> (see _utilities.scss), so
    // its animationend BUBBLES up to the root along with every other animation on the
    // page. An unfiltered {once: true} listener here would be spent by whichever
    // animation happened to finish first — the Jonson dot shimmer, a marquee — and the
    // class would never be cleared. Hence the animationName check.
    if (root.classList.contains('is-page-entering')) {
        const clear = () => {
            root.removeEventListener('animationend', onEnterEnd);
            root.classList.remove('is-page-entering');
        };
        const onEnterEnd = (e) => {
            if (e.animationName !== 'c-warp-in') return;
            clear();
        };
        root.addEventListener('animationend', onEnterEnd);
        setTimeout(clear, 900); // fallback if animationend never fires
    }

    // Departure — intercept plain, same-tab, same-origin navigations and warp out
    // first. Everything else (new tab, modified click, downloads, external links,
    // in-page anchors) is left to the browser.
    const onClick = (e) => {
        if (e.defaultPrevented || e.button !== 0 ||
            e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
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
            return; // unparseable (e.g. javascript:) — let the browser handle it
        }
        if (url.origin !== location.origin) return;   // external / mailto: / tel:
        if (url.href === location.href) return;        // same page
        if (url.pathname === location.pathname &&
            url.search === location.search && url.hash) {
            return;                                    // in-page anchor
        }

        // Hand off to the next page so it warps in.
        try {
            sessionStorage.setItem(FLAG, '1');
        } catch (err) { /* private mode etc. — enter warp is skipped, no harm */ }

        if (reduce) return; // reduced-motion: navigate normally, no warp-out

        e.preventDefault();
        root.classList.remove('is-page-entering'); // in case a click lands mid-arrival
        root.classList.add('is-page-leaving');

        // Tell anything expensive to stand down for the length of the warp. The
        // animation scales and fades the whole document, so every continuously
        // repainting thing on the page — the point cloud above all — is being
        // recomposited on each frame of it, competing for exactly the frames the
        // transition needs. Announced rather than reached for directly, so this
        // doesn't have to know what's listening.
        document.dispatchEvent(new CustomEvent('page:leaving'));

        let navigated = false;
        const go = () => {
            if (navigated) return;
            navigated = true;
            root.removeEventListener('animationend', onLeaveEnd);
            location.href = url.href;
        };
        // Same bubbling caveat as the arrival listener above, and worse here: an
        // unfiltered listener would navigate away the moment ANY animation on the page
        // finished, cutting the warp-out short or firing it almost immediately.
        const onLeaveEnd = (e) => {
            if (e.animationName !== 'c-warp-out') return;
            go();
        };
        root.addEventListener('animationend', onLeaveEnd);
        setTimeout(go, OUT_MS + 120); // fallback if animationend doesn't fire
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
}
