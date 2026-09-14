/**
 * CASE STUDY SECTION STRIP (see _components/case-toc.twig).
 *
 * The second TOC — the one for pages made of pictures. The notes panel is a persistent
 * column, which on a case study sits on top of the work; this is a bar pinned to the
 * window that appears once the reader is into the body and occupies nothing until then.
 *
 * It adds three things to markup that already works without it: the pinning, the
 * current-section marker, and Image Mode.
 *
 * It does NOT move the page. The list is real anchors, so jumping to a section is the
 * browser's job — there were prev/next steppers and an arrow-key shortcut here, and
 * both went: three ways to do one thing made a toolbar out of what should read as a
 * label.
 *
 * "Current section" is computed exactly as toc.js does it — the last heading to have
 * passed a line a quarter of the way down the viewport. Deliberately the same rule: two
 * components answering the same question differently is how a site ends up disagreeing
 * with itself about where the reader is.
 */

// Where the strip starts and stops. It appears once the body has reached the top of the
// window, and gets out of the way again at the end — a reading control hanging over the
// footer is just furniture.
const SHOW_AFTER = 120; // px of the content block scrolled past before it slides in
const SLIDE_MS = 260;   // matches $c-case-toc-ms in _case-toc.scss

export function mountCaseToc(root = document) {
    const strip = root.querySelector('[data-case-toc]');
    if (!strip) return () => {};

    const content = root.querySelector('.c-case-content');
    const links = [...strip.querySelectorAll('[data-case-toc-link]')];
    const headings = links
        .map((a) => document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))))
        .filter(Boolean);
    if (!content || !headings.length) return () => {};

    const label = strip.querySelector('[data-case-toc-label]');
    const count = strip.querySelector('[data-case-toc-count]');
    const bar = strip.querySelector('[data-case-toc-progress]');
    const list = strip.querySelector('[data-case-toc-list]');
    const toggle = strip.querySelector('[data-case-toc-toggle]');
    // Hidden below md (see _case-toc.scss), so it may be present but unclickable. Every
    // use is guarded rather than the component bailing: the section nav is the reason
    // this strip exists and it has to work with or without the toggle.
    const modeBtn = strip.querySelector('[data-case-toc-mode]');
    const modeValue = strip.querySelector('[data-case-toc-mode-value]');
    let current = 0;
    let shown = false;
    let hideTimer = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- the list -------------------------------------------------------------
    const openList = () => {
        list.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onOutside, true);
    };
    const closeList = () => {
        list.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (e) => { if (!strip.contains(e.target)) closeList(); };

    // No goTo(). Moving between sections is the list's job and the list is real
    // anchors, so the browser does it — nothing here needs to scroll anything.

    // Escape only. There were arrow-key steps here too; they went because the arrows
    // are already on screen and reachable by Tab, and taking over ← → risks stealing
    // the page's own scrolling from someone who is just reading.
    const onKey = (e) => {
        if (e.key === 'Escape' && !list.hidden) { closeList(); toggle.focus(); }
    };

    // ---- image mode -----------------------------------------------------------
    // DELIBERATELY NOT REMEMBERED — not in storage, not in a cookie, nowhere. It sat in
    // sessionStorage so it carried between studies; it should not. Image Mode is a way of
    // looking at THIS page, and arriving at a case study with its writing already hidden
    // because of something you did on a different one is the site deciding how you read.
    // Every page load starts with the prose showing, which is the honest default for a
    // case study — the words are half of it.
    const setMode = (on) => {
        if (!modeBtn) return;
        content.classList.toggle('is-images-only', on);
        modeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        // The button says which state it is IN, not what pressing it would do. Both are
        // defensible; this one is unambiguous, where "View images only" on a button that
        // is already showing only images reads as an instruction that has not worked.
        //
        // aria-label tracks the visible words rather than staying fixed: the two must
        // agree, or a voice-control user says what they can see and nothing happens.
        // Only the VALUE is written. "Image Mode:" is static text in the markup so it
        // can carry its own weight (see _case-toc.scss) — setting the whole phrase from
        // here would mean writing markup from JS to keep the bold half.
        const words = on ? 'Image Mode: On' : 'Image Mode: Off';
        if (modeValue) modeValue.textContent = on ? 'On' : 'Off';
        modeBtn.setAttribute('aria-label', words);

        // The section nav goes away with the prose. Not merely because naming a hidden
        // heading points at nothing — the list COULD NOT WORK either way: the headings
        // are display:none in this mode, so they have no layout box and scrollIntoView
        // on one does nothing at all. A control that cannot do its job should not be on
        // screen offering to.
        strip.classList.toggle('is-images-only', on);
        if (on) closeList();
    };

    // ---- where we are ---------------------------------------------------------
    let queued = false;
    const measure = () => {
        queued = false;
        const box = content.getBoundingClientRect();

        // Visible between the top of the body and the end of it. `hidden` rather than a
        // class so it leaves the tab order with the paint — a bar sliding off screen
        // whose buttons are still tabbable is worse than one that stays.
        const want = box.top < -SHOW_AFTER && box.bottom > window.innerHeight * 0.4;
        if (want !== shown) {
            shown = want;
            clearTimeout(hideTimer);
            if (want) {
                strip.hidden = false;
                // FLUSH BEFORE THE CLASS. The strip is display:none until the line
                // above, and an element that gains a box in the same frame it gains
                // .is-in has no previous computed transform to move away FROM — the
                // browser resolves one style, sees translateY(none), and paints the bar
                // in place. It appeared rather than slid, and only on the way in; the
                // way out animates because the element is already on screen when the
                // class comes off.
                //
                // Reading offsetHeight forces style and layout to resolve now, which
                // makes translateY(-100%) a real previous value for the transition to
                // start from. It is a deliberate synchronous reflow on one element, at
                // the moment it becomes visible — not in a scroll loop.
                void strip.offsetHeight;
            } else {
                closeList();
                // HIDDEN once the slide is done, not just translated away. Parked at
                // translateY(-100%) it still occupies the strip of page above the
                // viewport — which rubber-banding at the top of a page brings into
                // view, so overscrolling revealed a bar that was supposed to be gone.
                hideTimer = setTimeout(() => { if (!shown) strip.hidden = true; }, SLIDE_MS);
            }
            strip.classList.toggle('is-in', want);
        }
        if (!want) return;

        // Progress through the body, clamped: the bar should read 100% at the end of the
        // last section, not at the end of the document, which includes what comes after.
        const travelled = Math.min(Math.max(-box.top, 0), box.height);
        bar.style.transform = `scaleX(${(travelled / box.height).toFixed(4)})`;

        // The last heading above the quarter line — the same rule toc.js uses.
        const line = window.innerHeight * 0.25;
        let best = 0;
        headings.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) best = i; });
        if (best === current) return;

        current = best;
        count.textContent = `${best + 1}/${headings.length}`;
        label.textContent = headings[best].textContent.trim();
        links.forEach((a, i) => a.setAttribute('aria-current', i === best ? 'true' : 'false'));
    };

    const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(measure);
    };

    const onClick = (e) => {
        if (e.target.closest('[data-case-toc-toggle]')) {
            list.hidden ? openList() : closeList();
        } else if (modeBtn && e.target.closest('[data-case-toc-mode]')) {
            setMode(modeBtn.getAttribute('aria-pressed') !== 'true');
        } else {
            const link = e.target.closest('[data-case-toc-link]');
            if (!link) return;
            closeList();
            // Scroll to it OURSELVES rather than letting the anchor navigate, so the
            // address bar keeps the page's own URL — a reader picking a section has not
            // asked to be handed a link to it, and #a-prototype-real-enough-to-get-
            // feedback in the URL bar is noise they then have to carry.
            //
            // The href stays in the markup: without JS the anchor still works, which is
            // the whole reason the list is anchors and not buttons.
            const target = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'start'});
        }
    };

    strip.addEventListener('click', onClick);
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll, {passive: true});
    measure();

    return () => {
        strip.removeEventListener('click', onClick);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onOutside, true);
    };
}
