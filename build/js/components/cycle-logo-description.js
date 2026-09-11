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

export function mountCycleLogoDescription(container) {
    const items = Array.from(container.querySelectorAll('.b-logo__item'));
    if (items.length < 2) return () => {};

    // Reduced-motion users get the first item only — no cycling.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        items.forEach((el, i) => {
            el.classList.toggle('is-current', i === 0);
        });
        return () => {};
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
    };
}
