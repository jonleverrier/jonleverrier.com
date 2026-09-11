// Testimonial slider — prev/next, dots, and left/right keys.
//
// Extracted from jonson-ask.js so it isn't only available inside a conversation:
// the sliders there are injected per answer and were delegated from the thread, which
// meant a slider on a static page (the caseStudy single) rendered its controls and
// did nothing when you pressed them.
//
// Delegated from a root rather than bound per slider, so it covers sliders that
// arrive later — streamed into an answer, or restored from a thread snapshot —
// without anything having to re-register them.

// Distance between two slides, cached per track.
//
// offsetLeft forces the browser to flush pending layout, and slideTo read it and then
// immediately wrote a transform — a layout flush at the exact moment the animation
// starts, which is the worst place for one. The step only changes when the slider is
// re-laid out, so measure once and reuse. Invalidated on resize (below), which is the
// only thing that moves it: the slide width is a container-query expression, and the
// two breakpoint steps in it are width changes too.
const steps = new WeakMap();

function stepFor(track, slides) {
    const cached = steps.get(track);
    if (cached) return cached;
    const step = slides[1].offsetLeft - slides[0].offsetLeft; // slide width + gap
    if (step) steps.set(track, step);
    return step;
}

// Promote the track for the length of the move, then let it go.
//
// `will-change: transform` used to sit on the track permanently, which keeps a GPU
// layer alive for the whole page whether or not anything is moving — the thing
// _method.scss:141 warns about. The hint is only worth anything just before a change,
// so it's applied per move and dropped on transitionend.
function promote(track) {
    track.style.willChange = 'transform';

    if (track._settle) {
        clearTimeout(track._settle);
        track.removeEventListener('transitionend', track._onSettle);
    }

    const done = () => {
        clearTimeout(track._settle);
        track.removeEventListener('transitionend', track._onSettle);
        track._settle = null;
        track._onSettle = null;
        track.style.willChange = '';
    };

    // transitionend can go missing — an interrupted transition, a hidden tab, or a
    // move that computes to no change at all. The timer guarantees the layer is
    // released either way; whichever fires first cancels the other.
    track._onSettle = (e) => { if (e.target === track && e.propertyName === 'transform') done(); };
    track.addEventListener('transitionend', track._onSettle);
    track._settle = setTimeout(done, 700); // comfortably past the 460ms transition
}

// Move a slider to a given index (clamped): slide the track, mark the active slide,
// sync the dots, and disable whichever end button can no longer move.
export function slideTo(slider, index) {
    const track = slider.querySelector('.c-testimonials__track');
    const slides = track?.querySelectorAll('.c-testimonial');
    if (!slides || slides.length < 2) return;
    const step = stepFor(track, slides);
    if (!step) return;
    const last = slides.length - 1;
    index = Math.max(0, Math.min(last, index));

    track.dataset.index = String(index);
    promote(track);
    track.style.transform = `translateX(-${index * step}px)`;
    slides.forEach((s, i) => s.classList.toggle('is-active', i === index));
    slider.querySelectorAll('.c-testimonials__dot')
        .forEach((d, i) => d.classList.toggle('is-active', i === index));

    // Prev/next stay visible at the ends, just disabled (not removed).
    const prev = slider.querySelector('.c-testimonials__cycle--prev');
    const next = slider.querySelector('.c-testimonials__cycle--next');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= last;
}

// Slides sit at scale(0.85) until they're `is-active` — that's how the off-view ones
// read as set back. Nothing in the markup marks the first one, so on a static page
// the opening quote rendered permanently shrunk until you pressed a control.
// jonson-ask.js does this when it injects a slider into an answer; static pages had
// no equivalent. Idempotent, so it leaves an already-initialised slider alone.
export function initTestimonials(root = document) {
    root.querySelectorAll('.c-testimonials.has-multiple').forEach((slider) => {
        if (slider.querySelector('.c-testimonial.is-active')) return;
        const slides = slider.querySelectorAll('.c-testimonial');
        if (slides.length) slides[0].classList.add('is-active');
        const track = slider.querySelector('.c-testimonials__track');
        if (track && track.dataset.index === undefined) track.dataset.index = '0';
    });
}

export function mountTestimonials(root = document) {
    if (!root) return () => {};

    initTestimonials(root === document ? document : root);

    const onClick = (e) => {
        const slider = e.target.closest && e.target.closest('.c-testimonials.has-multiple');
        if (!slider) return;
        const track = slider.querySelector('.c-testimonials__track');
        if (!track) return;
        const index = Number(track.dataset.index || 0);

        const dot = e.target.closest('.c-testimonials__dot');
        if (dot) {
            const dots = [...slider.querySelectorAll('.c-testimonials__dot')];
            slideTo(slider, dots.indexOf(dot));
        } else if (e.target.closest('.c-testimonials__cycle--next')) {
            slideTo(slider, index + 1);
        } else if (e.target.closest('.c-testimonials__cycle--prev')) {
            slideTo(slider, index - 1);
        }
    };

    const onKeydown = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const slider = e.target.closest && e.target.closest('.c-testimonials.has-multiple');
        if (!slider) return;
        e.preventDefault();
        const track = slider.querySelector('.c-testimonials__track');
        if (!track) return;
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        track.dataset.dir = String(delta);
        slideTo(slider, Number(track.dataset.index || 0) + delta);
    };

    // The step is a measured pixel distance and the track's offset is a multiple of
    // it, so a width change invalidates both. Re-slide to the SAME index rather than
    // just clearing the cache: the existing translateX was computed from the old step
    // and would leave the track parked between two slides.
    //
    // Width only — a mobile browser collapsing its address bar fires resize on every
    // scroll, and none of that moves a slide.
    let lastWidth = window.innerWidth;
    let debounce = 0;
    const onResize = () => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            const scope = root === document ? document : root;
            scope.querySelectorAll('.c-testimonials.has-multiple').forEach((slider) => {
                const track = slider.querySelector('.c-testimonials__track');
                if (!track) return;
                steps.delete(track);
                slideTo(slider, Number(track.dataset.index || 0));
            });
        }, 150);
    };

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize, {passive: true});

    return () => {
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        window.removeEventListener('resize', onResize);
        clearTimeout(debounce);
    };
}
