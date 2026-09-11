// Sticky header state — tells CSS the moment .b-header actually pins.
//
// The header sits lower at rest than it does once stuck, and `position: sticky`
// can't express two heights: it clamps to max(natural position, top), and this
// header's natural position is above its stuck offset, so it pins immediately and
// never travels. So `top` owns the stuck height, a transform on the inner bar owns
// the resting height, and this swaps between them (see _header.scss).
//
// IntersectionObserver rather than a scroll listener: the sentinel is a zero-height
// probe pinned at the header's resting line, and the browser tells us when it leaves
// — no work on any frame where nothing changes. A scroll handler would run on every
// scroll event forever to answer a question that changes twice.

const ROOT_CLASS = 'is-header-stuck';

export function mountStickyHeader() {
    const header = document.querySelector('.b-header');
    const slab = header && header.closest('.b-slab');
    if (!header || !slab || !('IntersectionObserver' in window)) return () => {};

    const root = document.documentElement;

    // A zero-height sentinel at the top of the slab. It's a functional probe, not
    // decoration — nothing is drawn, and it carries no content.
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden;';
    slab.prepend(sentinel);

    const io = new IntersectionObserver(
        ([entry]) => root.classList.toggle(ROOT_CLASS, !entry.isIntersecting),
        // No rootMargin: the switch happens exactly when the SLAB'S TOP EDGE leaves
        // the viewport, and not a pixel before.
        //
        // Both bar heights are viewport-relative — sticky pins the header at its
        // `top` from the outset, so the bar sits at a fixed 51px unstuck and 34px
        // stuck no matter where you've scrolled. The slab's edge, by contrast, moves.
        // So the only thing that decides whether the logo crowds the green is WHEN
        // the swap fires: while that edge is still on screen it's somewhere between
        // 17px and 0px down, and dropping the bar to 34px puts it right on top of it.
        //
        // Pulling the line up to the edge itself means the bar never rises while
        // there's an edge to crowd — past it the green fills the top of the window
        // and there's nothing left to sit close to.
        //
        // The previous `-restOffset` margin measured the bar's distance below the
        // slab top and shrank the root by it. That's the resting GAP, not a scroll
        // position: at 34px it already excluded the sentinel at page load, so the
        // header was stuck from scroll 0 with 17px of green above it — the resting
        // height never showed at all.
        {threshold: 0},
    );
    io.observe(sentinel);

    return () => {
        io.disconnect();
        sentinel.remove();
        root.classList.remove(ROOT_CLASS);
    };
}
