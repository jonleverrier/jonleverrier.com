/**
 * FOOTER SECTIONS
 *
 * "Quick Links" and "Discuss a project" fold away behind their own headings on a
 * phone. Stacked, those two lists are a long scroll of links between the strapline
 * and the copyright line, and most of it is not what anyone came down here for.
 *
 * THE SCRIPT OWNS ALMOST NOTHING. The markup ships open (aria-expanded="true"), so
 * with no JS the footer is exactly what it always was — every link there, nothing
 * hidden behind a control that cannot run. All this does is close them once on a
 * narrow screen, and flip the attribute when one is pressed.
 *
 * The FOLD is CSS, keyed on that same attribute and scoped to below md (see
 * _footer.scss). That is deliberate: widening the window reveals both lists whatever
 * state they were left in, with no resize handler, nothing to keep in step, and no
 * way to strand a list hidden on a desktop. The attribute is the state, the
 * stylesheet decides whether the state means anything at this width, and both agree
 * because there is only one of them.
 *
**/

// Matches `@include mq(until, md)` — the mixin emits max-width with no epsilon, so
// this has to be `max-width` on the same value or the two disagree at exactly 48em.
const NARROW = '(max-width: 48em)';

export function mountFooterSections(root = document) {
    const toggles = [...root.querySelectorAll('[data-footer-toggle]')];
    if (!toggles.length) return () => {};

    // Closed to start with, but only where closing means anything. Read once: a
    // visitor who resizes past the breakpoint is handled by the stylesheet, not here.
    if (window.matchMedia(NARROW).matches) {
        toggles.forEach((t) => t.setAttribute('aria-expanded', 'false'));
    }

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
        document.removeEventListener('click', onClick);
        // Left open on teardown: the attribute is what the stylesheet reads, and a
        // footer whose links are hidden with nothing listening for a press would be
        // the one state this must never leave behind.
        toggles.forEach((t) => t.setAttribute('aria-expanded', 'true'));
    };
}
