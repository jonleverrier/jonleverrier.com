/**
 * FOOTER SECTIONS
 *
 * "Quick Links" and "Discuss a project" fold away behind their own headings on a
 * phone. Stacked, those two lists are a long scroll of links between the strapline
 * and the copyright line, and most of it is not what anyone came down here for.
 *
 * THE SCRIPT OWNS ALMOST NOTHING. The markup ships open (aria-expanded="true"), so
 * with no JS the footer is exactly what it always was — every link there, nothing
 * hidden behind a control that cannot run. All this does is set the attribute to
 * match the width, and flip it when one is pressed.
 *
 * The FOLD is CSS, keyed on that same attribute and scoped to below md (see
 * _footer.scss). The attribute is the state; the stylesheet decides whether the state
 * means anything at this width.
 *
 * ON THE CROSSING, both ways. Reading the width once at mount was not enough: land on
 * a desktop, where all three ship open, then narrow the window, and the fold applied
 * to three sections still marked expanded — every list open, which is the one thing
 * folding them was for. The reverse was quieter but worse: collapse a section on a
 * phone, widen, and the button reported aria-expanded="false" over a list plainly on
 * screen, which is a lie to anything reading the page rather than looking at it.
 *
 * So the attribute follows the query in both directions. Crossing the breakpoint
 * resets what was open — deliberate, since the layout it belonged to is gone.
 *
**/

// Matches `@include mq(until, md)` — the mixin emits max-width with no epsilon, so
// this has to be `max-width` on the same value or the two disagree at exactly 48em.
const NARROW = '(max-width: 48em)';

export function mountFooterSections(root = document) {
    const toggles = [...root.querySelectorAll('[data-footer-toggle]')];
    if (!toggles.length) return () => {};

    // Closed where closing means something, open where it does not — and kept in step
    // as the window crosses the breakpoint, in both directions.
    const narrow = window.matchMedia(NARROW);
    const syncToWidth = () => {
        const collapsed = narrow.matches ? 'false' : 'true';
        toggles.forEach((t) => t.setAttribute('aria-expanded', collapsed));
    };
    syncToWidth();
    narrow.addEventListener('change', syncToWidth);

    const onClick = (e) => {
        const toggle = e.target.closest('[data-footer-toggle]');
        if (!toggle || !root.contains(toggle)) return;
        toggle.setAttribute(
            'aria-expanded',
            toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true',
        );
    };

    document.addEventListener('click', onClick);

    return () => {
        narrow.removeEventListener('change', syncToWidth);
        document.removeEventListener('click', onClick);
        // Left open on teardown: the attribute is what the stylesheet reads, and a
        // footer whose links are hidden with nothing listening for a press would be
        // the one state this must never leave behind.
        toggles.forEach((t) => t.setAttribute('aria-expanded', 'true'));
    };
}
