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

// CAL.COM. Two hosts, and the difference matters: cal.com/<user>/<event> is the human
// link the CMS holds and the one the CTA still points at everywhere outside the panel,
// while app.cal.com is where the embed script and the booking frame actually come from.
// app.cal.com is therefore the origin the CSP names in script-src and frame-src (see
// craft/modules/frontend/FrontEnd.php) and the one worth preconnecting.
const CAL_ORIGIN = 'https://app.cal.com';
const CAL_EMBED_JS = `${CAL_ORIGIN}/embed/embed.js`;
// The namespace Cal files this embed under. One booking surface here, so one namespace,
// named for the CTA it belongs to.
const CAL_NS = 'callback';

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
    const bookingWrap = panel.querySelector('[data-contact-panel-booking-target]');
    const bookingFrame = panel.querySelector('[data-contact-panel-booking-frame]');
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

    // Warm the connection to Cal the moment the panel opens, so their embed script has a
    // live socket waiting if "request a call back" is pressed.
    //
    // PRECONNECT, NOT PREFETCH, and the distinction is the whole point: preconnect does
    // the DNS lookup, the TCP handshake and the TLS negotiation and then stops. It
    // fetches nothing, so Cal's script — and its frame, and its cookies — still arrive
    // only if the visitor actually asks for them. Prefetching the document would load a
    // third party on behalf of someone who may never press the button.
    //
    // NO `crossorigin` attribute. Both things this warms — a <script src> from app.cal.com
    // and the frame Cal then opens on it — are plain, non-CORS requests, and CORS and
    // non-CORS use different connection pools: a crossorigin preconnect would warm the
    // pool this never draws from and the handshake would be paid twice.
    //
    // Only when there is a booking CTA on the panel to open, and only once per page:
    // `warmed` is set on the first open and the tag is left in the head after that.
    let warmed = false;
    const warmBooking = () => {
        if (warmed || !bookingFrame) return;
        if (!panel.querySelector('a[data-cta-kind="callback"][href]')) return;
        warmed = true;
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = CAL_ORIGIN;
        document.head.appendChild(link);
    };

    const open = (from) => {
        if (panel.open) return;
        clearTimeout(closing);
        warmBooking();
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
            // Back to the first step for next time: the button returns, the form and
            // the booking step go (their transition is off while hidden, so the reset
            // is unseen). Nothing is thrown away — `hidden` is display:none, so a
            // half-written message stays in its fields and Cal's frame stays mounted
            // with whatever the visitor had picked.
            //
            // BOTH second steps have to go, not just the one that was showing. The
            // stage is a flex row and its height is the tallest step in it, so a
            // booking step left visible keeps the stage at the embed's height — around
            // 820px — even with the ways in back on screen. The panel then opens on a
            // column of empty space with the brands strip pushed below the fold.
            clearTimeout(stepTimer);
            if (steps) {
                steps.classList.add('is-settled');
                steps.classList.remove('is-form');
            }
            if (sent && writeWrap) writeWrap.remove(); // the button goes; nothing takes its place
            if (formWrap) formWrap.hidden = true;
            if (bookingWrap) bookingWrap.hidden = true;
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

    // Slide the stage to a second step. Written once and used by both — the message
    // form and the booking frame are the same move, and the only differences are which
    // panel comes in, what gets focus when it lands, and whether that focus is allowed
    // to scroll the panel to it.
    //
    // THAT LAST ONE IS NOT A DETAIL. The panel is its own scroller, and focusing an
    // element the browser thinks is out of view makes it scroll there. For the form
    // that is the point: the first field can genuinely sit below the fold. For the
    // booking step it is a bug — the step arrives at the top of the panel with nothing
    // above it to scroll past, but the embed is taller than the panel, so the browser
    // scrolls anyway trying to fit it and drags the panel's title out under the top
    // edge. A dozen pixels, on a press that should not move anything.
    const showStep = (wrap, focusTarget, preventScroll = false) => {
        if (!wrap || !steps) return;
        clearTimeout(stepTimer);
        wrap.hidden = false;
        // Two frames: the first paints it (display), the second starts the slide.
        requestAnimationFrame(() => requestAnimationFrame(() => steps.classList.add('is-form')));
        stepTimer = setTimeout(() => {
            steps.classList.add('is-settled');
            if (waysWrap) waysWrap.hidden = true;
            steps.classList.remove('is-form');
            requestAnimationFrame(() => requestAnimationFrame(() => steps.classList.remove('is-settled')));
            const el = typeof focusTarget === 'function' ? focusTarget() : focusTarget;
            if (el) el.focus({preventScroll});
        }, reduced ? 0 : FORM_MS);
    };

    const onWrite = () => showStep(
        formWrap,
        () => formWrap && formWrap.querySelector('input:not([type="hidden"]):not([tabindex="-1"]), textarea'),
    );

    // The event as Cal names it — "jonleverrier/callback" — read off the CTA's own href
    // so the booking link lives in the CMS and nowhere else. Both spellings reduce to
    // the same thing: cal.com/x/y is what Jon pastes, app.cal.com/x/y is what the embed
    // serves, and Cal wants neither host, just the path.
    //
    // Anything that is not a Cal link gets an empty string, and the caller leaves the
    // click alone: a CTA pointed somewhere else stays an ordinary link to somewhere
    // else, rather than being forced into an embed that cannot render it.
    const calLink = (href) => {
        let url;
        try {
            url = new URL(href, location.href);
        } catch {
            return '';
        }
        if (!/(^|\.)cal\.com$/i.test(url.hostname)) return '';

        return url.pathname.replace(/^\/+|\/+$/g, '');
    };

    // Cal's embed, mounted into the booking step's empty box.
    //
    // The block below is Cal's own loader, from the snippet their dashboard hands out,
    // reproduced rather than re-invented: it defines a stub `Cal()` that queues every
    // call made before embed.js has landed, appends the script, and lets embed.js replay
    // the queue when it arrives. Rewriting that handshake would be rewriting their API.
    //
    // What IS ours is when it runs. The snippet is meant for the <head> of a page that
    // shows a calendar; here it runs on the first press of "request a call back", so a
    // visitor who never opens the booking step never fetches a byte of Cal's — and the
    // event comes from the link rather than being hard-coded, so the CMS stays the one
    // place the booking URL is written.
    //
    // Once only. A second press must not re-mount: that would tear down the frame and
    // throw away a booking half-filled in.
    let calMounted = false;
    const mountCal = (link) => {
        if (calMounted) return;
        calMounted = true;

        const queue = (api, args) => { api.q.push(args); };
        window.Cal = window.Cal || function () {
            const cal = window.Cal;
            const args = arguments;
            if (!cal.loaded) {
                cal.ns = {};
                cal.q = cal.q || [];
                document.head.appendChild(document.createElement('script')).src = CAL_EMBED_JS;
                cal.loaded = true;
            }
            if (args[0] === 'init') {
                const api = function () { queue(api, arguments); };
                const namespace = args[1];
                api.q = api.q || [];
                if (typeof namespace === 'string') {
                    cal.ns[namespace] = cal.ns[namespace] || api;
                    queue(cal.ns[namespace], args);
                    queue(cal, ['initNamespace', namespace]);
                } else {
                    queue(cal, args);
                }

                return;
            }
            queue(cal, args);
        };

        const Cal = window.Cal;
        Cal('init', CAL_NS, {origin: CAL_ORIGIN});
        // Carries ?utm_… and any prefill on the current URL through to the booking, so a
        // visit that arrived tagged is still tagged by the time it books.
        Cal.config = Cal.config || {};
        Cal.config.forwardQueryParams = true;

        Cal.ns[CAL_NS]('inline', {
            elementOrSelector: bookingFrame,
            calLink: link,
            // month_view because the panel is a tall, narrow column and the month grid is
            // the layout that fits one; useSlotsViewOnSmallScreen drops it to the times
            // list on a phone, where the grid has no room to be a grid.
            config: {layout: 'month_view', useSlotsViewOnSmallScreen: 'true'},
        });
        Cal.ns[CAL_NS]('ui', {hideEventTypeDetails: false, layout: 'month_view'});
    };

    // "Request a call back" opens in place rather than leaving the site.
    const onBooking = (a) => {
        if (!bookingWrap || !bookingFrame) return false;
        const link = calLink(a.getAttribute('href') || '');
        if (!link) return false; // not a Cal link — let it navigate as the CMS wrote it
        mountCal(link);
        showStep(bookingWrap, bookingFrame, true);

        return true;
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
    // Clicks inside the panel. Two jobs, in one listener because they are one event:
    // the backdrop closes, and the booking CTA opens in place instead of navigating.
    //
    // The booking intercept is HERE and not on the document, so it only ever applies
    // inside the panel — the same CTA in the footer and on the contact page stays an
    // ordinary link, because there is no stage to slide there.
    const onPanelClick = (e) => {
        // A click on the backdrop lands on the dialog element itself, not its inner.
        if (e.target === panel) {
            close();

            return;
        }
        // Modified clicks are the visitor asking for a new tab or window; let them.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a[data-cta-kind="callback"][href]');
        if (a && onBooking(a)) {
            e.preventDefault();
            e.stopPropagation();
        }
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
