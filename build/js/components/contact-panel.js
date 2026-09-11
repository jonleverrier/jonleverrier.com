/**
 * CONTACT PANEL
 *
 * Opens the contact side panel (_components/contact-panel, a native <dialog>) in
 * place of a trip to /contact. Any plain, same-tab click on a link to the contact
 * page — the header's Contact button, the footer's link, the Jonson contact beat
 * dropped into an answer — is intercepted here and opens the panel instead. The
 * links keep their href, so without this script, in a new tab, or on a shared
 * link the contact page still does its job; and ON the contact page the links
 * are left alone, since the page is the destination.
 *
 * The panel has two steps: the light ways in (the CTAs), and the form behind a
 * "send me a message" button, revealed on request and never before.
 *
 * The click listener runs in the capture phase so it gets the click before the
 * page-transition script, which would otherwise start its warp-out for the
 * navigation we're replacing.
 *
**/

import {setupMarquee, teardownMarquee} from './clients-marquee.js';

// The panel's closing slide — matches $c-contact-panel-exit in _contact-panel.scss
// (the exit is shorter than the enter, on purpose).
const SLIDE_MS = 260;

export function mountContactPanel() {
    const panel = document.querySelector('[data-contact-panel]');
    if (!panel || typeof panel.showModal !== 'function') return () => {};

    const root = document.documentElement;
    const inner = panel.querySelector('.c-contact-panel__inner');
    const closeBtn = panel.querySelector('[data-contact-panel-close]');
    const writeBtn = panel.querySelector('[data-contact-panel-form]');
    const steps = panel.querySelector('[data-contact-panel-steps]');
    const waysWrap = panel.querySelector('[data-contact-panel-ways]');
    const formWrap = panel.querySelector('[data-contact-panel-form-target]');
    let stepTimer = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const strip = (path) => path.replace(/\/+$/, '') || '/';
    let contactPath;
    try {
        contactPath = strip(new URL(panel.getAttribute('data-contact-url') || '/contact', location.href).pathname);
    } catch {
        contactPath = '/contact';
    }
    const onContactPage = strip(location.pathname) === contactPath;

    let trigger = null;   // what opened it, to give focus back to
    let closing = 0;

    // Sent from this panel, this page load: on the next close the panel settles
    // into the same shape a later page load renders server-side (see the
    // template) — the ways in alone, no button and no second step.
    let sent = false;
    const writeWrap = panel.querySelector('.c-contact-panel__write');
    const onSent = (e) => {
        const el = e.detail && e.detail.el;
        if (formWrap && el && formWrap.contains(el)) sent = true;
    };

    // The brands strip is built by the page-load pass while the dialog is still
    // closed (display none), so it measured zero and sized its loop from nothing.
    // Rebuild it once, the first time the panel is open and has a width.
    let stripBuilt = false;
    const buildStrip = () => {
        if (stripBuilt) return;
        stripBuilt = true;
        panel.querySelectorAll('.c-clients').forEach((el) => {
            teardownMarquee(el);
            setupMarquee(el);
        });
    };

    // How the visitor is driving: the last input seen. A pointer opening the panel
    // after a keyboard session finds the trigger still wearing its focus ring
    // (focus came back to it on the last close), so the ring alone can't tell the
    // two apart — the last event can.
    let byPointer = false;
    const onPointerDown = () => { byPointer = true; };
    const onKeyDown = () => { byPointer = false; };

    const open = (from) => {
        if (panel.open) return;
        clearTimeout(closing);
        trigger = from || null;
        const byKeyboard = !byPointer;
        panel.showModal();
        root.classList.add('has-contact-panel');
        // Two frames: the first paints it (display), the second starts the slide.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            panel.classList.add('is-open');
            buildStrip();
        }));
        // Where focus lands depends on how it was opened. From the keyboard, the
        // first way in — not the close button, which is a way out. From a
        // pointer, the panel itself: Chrome paints :focus-visible on a scripted
        // focus whatever opened it, so landing on the pill drew its ring and
        // arrow as if it had been tabbed to.
        const first = byKeyboard ? panel.querySelector('.c-ctas__item[href], [data-contact-panel-form]') : null;
        if (first) first.focus({preventScroll: true});
        else if (inner) inner.focus({preventScroll: true});
    };

    const close = () => {
        if (!panel.open) return;
        panel.classList.remove('is-open');
        const done = () => {
            if (panel.open) panel.close();
            root.classList.remove('has-contact-panel');
            // Back to the first step for next time: the button returns, the form
            // goes (its transition is off while hidden, so the reset is unseen).
            // Anything typed stays in the fields — a half-written message
            // shouldn't vanish because the panel was closed.
            clearTimeout(stepTimer);
            if (steps) {
                steps.classList.add('is-settled');
                steps.classList.remove('is-form');
            }
            if (sent && writeWrap) writeWrap.remove(); // the button goes; nothing takes its place
            if (formWrap) formWrap.hidden = true;
            if (waysWrap) waysWrap.hidden = false;
            if (steps) requestAnimationFrame(() => requestAnimationFrame(() => steps.classList.remove('is-settled')));
            if (trigger && trigger.isConnected) trigger.focus({preventScroll: true});
            trigger = null;
        };
        if (reduced) done();
        else closing = setTimeout(done, SLIDE_MS);
    };

    // The second step: the track slides one step left, pushing the ways in out as
    // the form comes in (see .c-contact-panel__steps). Once settled, the first
    // step is hidden and the shift undone in the same frame — the form is then
    // column one, exactly where the shift had it — so the stage is the form's
    // height alone; then focus lands on the first field (and the panel scrolls
    // to it if it's below the fold).
    const FORM_MS = 380; // matches .c-contact-panel__step's transition
    const onWrite = () => {
        if (!formWrap || !steps) return;
        clearTimeout(stepTimer);
        formWrap.hidden = false;
        // Two frames: the first paints it (display), the second starts the slide.
        requestAnimationFrame(() => requestAnimationFrame(() => steps.classList.add('is-form')));
        const first = formWrap.querySelector('input:not([type="hidden"]):not([tabindex="-1"]), textarea');
        stepTimer = setTimeout(() => {
            steps.classList.add('is-settled');
            if (waysWrap) waysWrap.hidden = true;
            steps.classList.remove('is-form');
            requestAnimationFrame(() => requestAnimationFrame(() => steps.classList.remove('is-settled')));
            if (first) first.focus({preventScroll: false});
        }, reduced ? 0 : FORM_MS);
    };

    // A same-tab click on a link to the contact page opens the panel instead.
    const onClick = (e) => {
        if (onContactPage) return;
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
        let url;
        try {
            url = new URL(a.getAttribute('href'), location.href);
        } catch {
            return;
        }
        if (url.origin !== location.origin || strip(url.pathname) !== contactPath) return;
        e.preventDefault();
        e.stopPropagation(); // before the page-transition's own listener sees it
        open(a);
    };

    // Escape fires the dialog's cancel: take over, so the close is the slide too.
    const onCancel = (e) => {
        e.preventDefault();
        close();
    };
    // A click on the backdrop lands on the dialog element itself, not its inner.
    const onPanelClick = (e) => {
        if (e.target === panel) close();
    };

    document.addEventListener('contact:success', onSent);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClick, true);
    panel.addEventListener('cancel', onCancel);
    panel.addEventListener('click', onPanelClick);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (writeBtn) writeBtn.addEventListener('click', onWrite);

    return () => {
        clearTimeout(closing);
        document.removeEventListener('contact:success', onSent);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('click', onClick, true);
        panel.removeEventListener('cancel', onCancel);
        panel.removeEventListener('click', onPanelClick);
        if (closeBtn) closeBtn.removeEventListener('click', close);
        if (writeBtn) writeBtn.removeEventListener('click', onWrite);
        if (panel.open) panel.close();
        root.classList.remove('has-contact-panel');
    };
}
