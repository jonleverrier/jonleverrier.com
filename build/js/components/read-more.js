// Read more — collapses a block of prose to its opening paragraph.
//
// PROGRESSIVE ENHANCEMENT, deliberately. The markup ships fully expanded and nothing
// is hidden in CSS; this collapses it on mount. So with JS off, or before this runs,
// the whole thing is readable rather than permanently truncated with no way to open
// it — the failure mode of hiding it in the stylesheet and relying on JS to reveal.
//
// ONE WAY: the button opens the prose and removes itself, as the meta column's
// "+N more" does. Collapsing is a thing this page does to text on arrival, not a
// mode the reader is in — once they've asked for the rest, a control offering to
// take it away again is just a way to lose their place.
//
// A <button>, not a link: it goes nowhere. Links are for navigation, and a "Read more"
// anchor with href="#" reads as a broken destination to a screen reader and puts a
// junk entry in the history.

const SEL = '[data-read-more]';
const BTN = 'c-read-more';

const LABEL_MORE = 'Read more';

function setup(el) {
    if (el._readMore) return;

    // Only worth a control if something would actually be hidden. One paragraph
    // collapses to itself, and a "Read more" that reveals nothing is worse than none.
    const blocks = Array.from(el.children);
    if (blocks.length < 2) return;

    const btn = document.createElement('button');
    btn.type = 'button'; // inside a form this would otherwise submit it
    btn.className = BTN;
    btn.textContent = LABEL_MORE;

    el.classList.add('is-collapsed');
    el.appendChild(btn);

    // Reveal, then retire — including the listener and the teardown hook, so what's
    // left is the block exactly as it was served.
    const reveal = () => {
        btn.removeEventListener('click', reveal);
        btn.remove();
        el.classList.remove('is-collapsed');
        el._readMore = null;
    };

    btn.addEventListener('click', reveal);

    // Same shape as the click, so unmounting a block the reader never opened leaves
    // it in that same served state.
    el._readMore = reveal;
}

/** Collapse every [data-read-more] block inside `root`. Idempotent. */
export function mountReadMore(root = document) {
    if (!root) return () => {};

    const scope = root === document ? document : root;
    scope.querySelectorAll(SEL).forEach(setup);

    return () => {
        scope.querySelectorAll(SEL).forEach((el) => {
            if (el._readMore) el._readMore();
        });
    };
}
