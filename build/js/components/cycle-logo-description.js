/**
 * CYCLE LOGO DESCRIPTION
 *
 * Cycles through .b-logo__item elements one at a time. All entries
 * remain in the DOM so search engines index them; CSS controls visibility
 * via .is-current / .is-leaving.
 *
**/

// A one-second move, then a one-second hold. ANIM_DURATION matches
// $b-logo-ticker-duration in _logo.scss — it's only used to know when the leaving
// line has cleared the mask and can drop its class.
const CYCLE_INTERVAL = 2000;
const ANIM_DURATION = 1000;

// ONE LINE, ALWAYS. The band the titles slide through is as tall as the tallest
// title, so a title that wraps makes it two lines deep — and every one-line title
// then turns over as two half-lines mid-slide, with a blank row under it at rest.
// "AI Product Designer" is 189px in a 189px space on a 402px phone: it fits in
// Chrome and wraps in iPhone WebKit (LinkedIn, 2026-09-30). So the titles never
// wrap (see _logo.scss), and when the longest won't fit, all of them shrink together
// by just enough. Measured, not a breakpoint: the titles come from the CMS.
const FIT_MIN_PX = 11;

function fitToOneLine(container, items) {
    items.forEach((el) => { el.style.fontSize = ''; el.style.whiteSpace = ''; });
    const avail = container.clientWidth;
    if (!avail) return;
    const widest = Math.max(...items.map((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect().width;
    }));
    if (widest <= avail) return;
    const base = parseFloat(getComputedStyle(items[0]).fontSize);
    // A hair under the exact ratio, so sub-pixel rounding can't tip it back over.
    const size = Math.floor(base * (avail / widest) * 10) / 10 - 0.1;
    // Below the floor it would be too small to read (a 320px phone): keep the normal
    // size and let the titles wrap there instead, as they used to.
    items.forEach((el) => {
        if (size >= FIT_MIN_PX) el.style.fontSize = `${size}px`;
        else el.style.whiteSpace = 'normal';
    });
}

export function mountCycleLogoDescription(container) {
    const items = Array.from(container.querySelectorAll('.b-logo__item'));
    if (!items.length) return () => {};

    const fit = () => fitToOneLine(container, items);
    fit();
    document.fonts?.ready.then(fit); // the webfont is wider than the fallback
    // The WINDOW, not the list: the title's width follows its own text (the logo is
    // content-sized), so once the text is shrunk the list never grows back by itself
    // and an observer on it would never fire as the window widens again.
    let frame = 0;
    const onResize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    window.addEventListener('resize', onResize);
    const ro = { disconnect: () => window.removeEventListener('resize', onResize) };
    if (items.length < 2) return () => ro.disconnect();

    // Reduced-motion users get the first item only — no cycling.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        items.forEach((el, i) => {
            el.classList.toggle('is-current', i === 0);
        });
        return () => ro.disconnect();
    }

    let currentIndex = items.findIndex((el) => el.classList.contains('is-current'));
    if (currentIndex < 0) {
        currentIndex = 0;
        items[0].classList.add('is-current');
    }

    const tick = () => {
        const nextIndex = (currentIndex + 1) % items.length;
        const current = items[currentIndex];
        const next = items[nextIndex];

        current.classList.remove('is-current');
        current.classList.add('is-leaving');
        next.classList.add('is-current');

        setTimeout(() => current.classList.remove('is-leaving'), ANIM_DURATION + 100);

        currentIndex = nextIndex;
    };

    const timerId = setInterval(tick, CYCLE_INTERVAL);

    return function dispose() {
        clearInterval(timerId);
        ro.disconnect();
    };
}
