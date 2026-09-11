// "+N more" — caps a meta row's item list at the first N, with a one-shot control for
// the rest.
//
// PROGRESSIVE ENHANCEMENT, the same bargain read-more.js makes: the row ships with
// every item present and nothing hidden, and this collapses it on mount. So the full
// list is in the served HTML — readable with JS off, and there for a crawler — rather
// than truncated in CSS or, worse, injected later by script.
//
// ONE WAY, unlike Read more: the button reveals the rest and removes itself. Read more
// hides paragraphs, and a reader who opened one may well want the column short again;
// this hides four words at the end of a line, and a "Show less" offering to put them
// back is a control that isn't worth its own space. Once the list is open it's just a
// list.
//
// The count in the label is the number ACTUALLY hidden, not (total - limit) worked out
// in the template: if the two ever disagree, the one the visitor can verify by clicking
// is the one that should be on the button.
//
// A <button>, not a link: it goes nowhere.

const SEL = '[data-meta-more]';
const ITEM = '.c-meta__item';
const BTN = 'c-meta__more';

function setup(el) {
    if (el._metaMore) return;

    const limit = Number.parseInt(el.dataset.metaMore, 10);
    if (!Number.isFinite(limit) || limit < 1) return;

    const overflow = Array.from(el.querySelectorAll(ITEM)).slice(limit);
    // Only worth a control if something would actually be hidden — a "+0 more" that
    // reveals nothing is worse than no control at all.
    if (!overflow.length) return;

    const btn = document.createElement('button');
    btn.type = 'button'; // inside a form this would otherwise submit it
    btn.className = BTN;
    btn.textContent = `+${overflow.length} more`;

    // `hidden` rather than a class: it takes the items out of the accessibility tree
    // as well as the layout, so a screen reader isn't read a list the page says is
    // capped.
    overflow.forEach((item) => { item.hidden = true; });
    // ", " before the button — the toggle is the list's last item ("Front-end, Craft
    // CMS, +4 more"), so it takes the same separator the items do. A text node in the
    // row, NOT part of the button: the comma stays in the value's colour and only
    // "+4 more" reads as the link. And a text node, NOT a margin (see _meta.scss): a
    // margin keeps its width wherever the button lands, so when the list filled a line
    // exactly and the button wrapped, the gap became an indent under the first word.
    // The comma leaves with the button on reveal, so the open list never ends on one.
    const gap = document.createTextNode(', ');
    el.appendChild(gap);
    el.appendChild(btn);

    // Reveal, then retire — including the listener and the teardown hook, so what's
    // left is the row exactly as it was served.
    const reveal = () => {
        btn.removeEventListener('click', reveal);
        gap.remove();
        btn.remove();
        overflow.forEach((item) => { item.hidden = false; });
        el._metaMore = null;
    };

    btn.addEventListener('click', reveal);

    // Same shape as the click, so unmounting a row the visitor never opened leaves it
    // in that same served state.
    el._metaMore = reveal;
}

/** Cap every [data-meta-more] row inside `root` at its limit. Idempotent. */
export function mountMetaMore(root = document) {
    if (!root) return () => {};

    const scope = root === document ? document : root;
    scope.querySelectorAll(SEL).forEach(setup);

    return () => {
        scope.querySelectorAll(SEL).forEach((el) => {
            if (el._metaMore) el._metaMore();
        });
    };
}
