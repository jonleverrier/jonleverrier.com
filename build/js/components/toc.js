/**
 * TOC — "on this page" nav (see _components/toc). Marks the link whose section
 * is in view as the reader scrolls. The nav is real anchors and works without
 * this; this only adds the current-section marker.
 *
 * "In view" = the last heading that has passed a line a quarter of the way
 * down the viewport. Recomputed on scroll (passive, one pass per frame) — a
 * plain read of each heading's position, which is cheap for a handful of
 * headings and never blinks off between sections the way an observer band
 * can.
 */

const WIDE = '(min-width: 1440px)'; // matches $c-toc-wide in _toc.scss

export function mountToc(root = document) {
    const nav = root.querySelector('[data-toc]');
    if (!nav) return () => {};

    // Folded by default on a narrow screen, where the panel sits in the flow
    // above the prose; always open on a wide one, where it's a sidebar. The
    // markup ships open, so without JS the list is simply there.
    const details = nav.querySelector('details');
    const wide = window.matchMedia(WIDE);
    const syncOpen = () => {
        if (!details) return;
        if (wide.matches) details.open = true;
        else if (!details.dataset.touched) details.open = false;
    };
    // Once the reader has opened or closed it themselves, leave it be.
    details?.addEventListener('toggle', () => { if (!wide.matches) details.dataset.touched = '1'; });
    syncOpen();
    wide.addEventListener('change', syncOpen);

    const links = [...nav.querySelectorAll('a[href^="#"]')];
    const headings = links
        .map((a) => document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))))
        .filter(Boolean);
    if (!headings.length) return () => {};

    const linkFor = new Map(headings.map((h, i) => [h, links[i]]));
    let current = null;
    let ticking = false;

    const setCurrent = (h) => {
        if (h === current) return;
        current = h;
        links.forEach((a) => a.classList.toggle('is-current', a === linkFor.get(h)));
    };

    // The last heading above the line is the current section; before the
    // first, the first.
    const update = () => {
        ticking = false;
        const line = window.innerHeight * 0.25;
        let best = null;
        for (const h of headings) {
            if (h.getBoundingClientRect().top <= line) best = h;
        }
        setCurrent(best || headings[0]);
    };

    const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
    };

    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll, {passive: true});
    update();

    return () => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        wide.removeEventListener('change', syncOpen);
    };
}
