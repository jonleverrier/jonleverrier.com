/**
 * PICTURE
 *
 * Marks each <picture> as loaded, which is what triggers the colour reveal
 * described in _picture.scss. Everything visual lives in the stylesheet; this
 * only answers the two questions CSS can't — has the image arrived, and has the
 * picture reached the screen?
 *
 * Only elements carrying `has-tone` are touched. An image with no placeholder is
 * already visible and has nothing to reveal.
 */

/**
 * Backstop for the reveal, measured from the moment the image is known to have
 * arrived. Must clear the longest reveal that can legitimately be running, or it
 * would cut one short. In _picture.scss that is the GRADIENT, not the image: the
 * hold (240ms) + half the fade (210ms) + the fade itself (420ms) — about 870ms.
 * No `--tone-delay` is in play any more (the rail's stagger went with the rail's
 * placeholder); if one comes back, add it here. Raise this if any go up.
 *
 * It exists because the frame-deferred start below relies on requestAnimationFrame,
 * which does not run at all while the tab is in the background. A page loaded in a
 * background tab would otherwise sit on its placeholders until the visitor came
 * back to it. A timer keeps running there, so this always lands.
 */
const SETTLE_MS = 1400;

/**
 * How long to wait on decode() before starting the fade anyway. Short enough that
 * a slow decode delays the reveal imperceptibly rather than holding a photo the
 * visitor is looking at, and it caps a decode that never settles.
 */
const DECODE_CAP_MS = 120;

/**
 * The reveal waits for TWO things: the image having arrived, and the picture
 * having reached the screen. Both, because either alone is wrong.
 *
 * Loading is not the cue. `loading="lazy"` starts fetching long before an image
 * is anywhere near the viewport — Chrome's threshold runs to thousands of pixels
 * — so a reveal fired on load plays while the picture is still far down the page.
 * Measured on a case study: images 1676px below the fold had loaded AND finished
 * developing in before the page had been scrolled at all. Every one of them was
 * fully resolved by the time it came into view, so the effect was invisible for
 * the entire page bar the topmost image.
 *
 * Keeping the fetch early and the reveal late is the whole point: the photo is
 * ready and waiting by the time you arrive at it, and the fade plays where it
 * can actually be seen.
 */
const seen = new WeakSet();
const armed = new WeakMap(); // picture -> callback to run once it comes into view
// Pictures already handled. A WeakSet, NOT a data attribute: the case-study
// marquee clones its cards (cloneNode copies attributes), and a clone that
// arrived flagged "watched" with no watcher behind it never developed — the
// visitor saw a row of colour washes and no thumbnails.
const watched = new WeakSet();

// How far a picture must travel INTO the viewport before it develops in, as a
// percentage of viewport height clipped off the bottom of the observer's box.
//
// Not zero. Firing on the first visible pixel means the reveal starts while the
// image is a sliver at the very bottom edge of the screen: measured, every image
// on a case study began fading with 4–6% of itself visible, top edge at ~685px of
// an 800px viewport. The fade runs ~620ms, so at any normal scrolling speed it had
// finished before the photo was properly in front of the reader — visible only in
// peripheral vision, which reads as the effect firing at random.
//
// 25% holds off until the image is a quarter of the way up the screen — about
// 200px of scrolling on an 800px viewport. Less hold-off than the blur-up
// needed, because the fade it gates is now 320ms rather than a second: a short
// reveal triggered too late finishes after the image has already gone past.
// It's the dial for this: raise it to hold off longer, drop it to fire sooner.
//
// Expressed as a margin rather than a threshold on purpose — a threshold is a
// fraction of the ELEMENT, so any image taller than the viewport could never
// reach a meaningful one and would never reveal at all.
const REVEAL_MARGIN = '0px 0px -25% 0px';

// One observer for the document rather than one per picture.
const inView = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            obs.unobserve(entry.target);
            seen.add(entry.target);
            const run = armed.get(entry.target);
            if (run) { armed.delete(entry.target); run(); }
        });
    }, {threshold: 0.01, rootMargin: REVEAL_MARGIN})
    : null;

/**
 * Watch every toned picture inside `root` (inclusive) and reveal it once its
 * image has loaded AND it has reached the screen.
 *
 * Safe to call repeatedly over the same DOM — an element already marked is
 * skipped, so re-running after injecting more content costs a query and no
 * duplicate listeners.
 */
// `immediate`: develop every picture now rather than when it scrolls into view —
// for a marquee, whose cards are all "on screen" as one moving strip, and whose
// clones would otherwise wait on an intersection that a transformed track can
// leave unmet. Pictures already armed and waiting are fired too.
export function revealPictures(root = document, {immediate = false} = {}) {
    // `root` can itself be a picture when a caller hands us a single element.
    const found = root.querySelectorAll ? root.querySelectorAll('.c-picture.has-tone') : [];
    const pictures = root.matches?.('.c-picture.has-tone') ? [root, ...found] : [...found];

    pictures.forEach((pic) => {
        if (watched.has(pic)) {
            if (immediate) {
                // Count it as seen, so an image still loading develops the moment
                // it arrives rather than waiting on an intersection; and fire one
                // already loaded and waiting.
                seen.add(pic);
                if (inView) inView.unobserve(pic);
                const run = armed.get(pic);
                if (run) { armed.delete(pic); run(); }
            }
            return;
        }
        watched.add(pic);

        const img = pic.querySelector('img');
        // Nothing to wait for. Reveal rather than leave it hidden — the image
        // is the content, and the placeholder is only ever a stand-in for it.
        if (!img) { pic.classList.add('is-loaded'); return; }

        // `is-developed` carries the reveal's end state with `transition: none`, so
        // the image is guaranteed to arrive even if the transition never plays. See
        // SETTLE_MS: requestAnimationFrame is the thing that can fail to run.
        const settle = () => setTimeout(() => pic.classList.add('is-developed'), SETTLE_MS);

        // Two frames before the class goes on, NOT because the delay is wanted, but
        // because a transition needs two distinct RENDERED states to interpolate
        // between. Setting the final state in the same frame the element is first
        // painted gives the browser one state, and it simply draws the image — no
        // fade at all.
        //
        // A cached image no longer reaches here at all — it is caught above and
        // snapped straight to the end state — so this now only ever runs for an
        // image that genuinely arrived over the network while the placeholder was
        // on screen. The two frames still matter for that case: the placeholder
        // has to be painted before the loaded state can be interpolated from it.
        //
        // Two rather than one because a single rAF still lands inside the frame
        // being assembled; the second guarantees the placeholder state has been
        // through a paint. `settle` is scheduled OUTSIDE the callback so a
        // background tab — where rAF never fires — still resolves via the timer.
        const paint = () => requestAnimationFrame(() => requestAnimationFrame(() => {
            pic.classList.add('is-loaded');
        }));

        const start = () => {
            settle();

            // Decode before starting the fade. `load` means the BYTES have
            // arrived, not that the bitmap is ready to draw — the browser
            // rasterises at display size on the first frame that actually paints
            // it, which is frame one of the fade. That work lands inside the
            // transition and shows up as a stutter at the exact moment it is most
            // visible, against a flat colour with nothing to hide it.
            //
            // decode() was pulled out of this file once before for hanging. That
            // was a different call site — it was being awaited for images with no
            // data yet, which never resolve. Here it only ever runs after `load`
            // or `complete`, so the data is present. The timeout is belt and
            // braces regardless: whatever decode() does, the fade starts.
            if (typeof img.decode !== 'function') { paint(); return; }

            let started = false;
            const once = () => { if (!started) { started = true; paint(); } };
            img.decode().then(once, once);
            setTimeout(once, DECODE_CAP_MS);
        };

        // DID THIS COME OUT OF THE CACHE? `complete` above catches an image that had
        // already arrived by the time we first looked, which on this site is only ever
        // the two or three above the fold: nearly every picture is loading="lazy", and
        // a lazy image below the fold is NOT fetched at page load even when it is
        // sitting in the cache. It is fetched when you scroll near it, fires `load`
        // like any other, and went down the fade path — so a return visit still played
        // a colour wash over twenty images that were already on the machine.
        //
        // transferSize === 0 is the cache hit: memory or disk, no bytes over the wire.
        // SAME-ORIGIN ONLY, because a cross-origin response without Timing-Allow-Origin
        // also reports 0 and would be indistinguishable from a cache hit — better to
        // fade something that was cached than to snap something the reader watched
        // load. If there is no entry at all (the resource-timing buffer fills at 250
        // and this page has more images than that), the same default applies.
        const fromCache = () => {
            try {
                const src = img.currentSrc || img.src;
                if (!src || new URL(src, location.href).origin !== location.origin) return false;
                const entries = performance.getEntriesByName(src);
                const t = entries[entries.length - 1];
                return !!t && t.transferSize === 0;
            } catch {
                return false;
            }
        };

        // Loaded — but hold it until the picture is actually on screen. Without an
        // IntersectionObserver (or once it has already reported this one) there is
        // nothing to wait for, so go straight away.
        const done = () => {
            // Nothing was waited for, so there is nothing to cover. Note this skips the
            // on-screen gate as well: the gate exists to put the fade where it can be
            // seen, and there is no fade.
            if (fromCache()) { snap(); return; }

            if (immediate || !inView || seen.has(pic)) { seen.add(pic); start(); return; }
            armed.set(pic, start);
        };

        // Straight to the end state: no observer, no frames, no fade.
        const snap = () => {
            seen.add(pic);
            pic.classList.add('is-loaded', 'is-developed');
        };

        // ALREADY HERE — so there is nothing to reveal.
        //
        // This is the cached case, and it is most of them — a repeat visit, a
        // back-navigation, scrolling back up to something already fetched, every
        // page on a local dev server. The image is sitting in memory ready to
        // paint, and playing a colour wash over it to fade it in says the opposite:
        // that something is loading. An effect whose whole job is to cover a wait
        // is noise when there was no wait.
        //
        // NOTE this reverses a deliberate decision. The two-frame `paint()` below
        // exists precisely so the transition would still play for a `complete`
        // image, on the grounds that the reveal was otherwise invisible on the
        // machines it gets looked at on. That was solving for seeing the effect
        // rather than for the effect doing its job. It still plays where it earns
        // its place — a real first load, where the photo genuinely isn't there yet.
        //
        // `complete` is also true for an image that FAILED, and that is fine: the
        // error path below does the same thing, since alt text has to be readable
        // and a gradient sitting over it would make it illegible.
        //
        // Checked BEFORE observing, so a cached picture is never registered with
        // the observer at all — nothing to unobserve, and no intersection callback
        // for an element that is already finished.
        if (img.complete) { snap(); return; }

        // Observe from the start, not from the load event, so a picture already on
        // screen is known to be visible by the time its image arrives and reveals
        // without waiting for a second observer callback.
        if (inView && !immediate) inView.observe(pic);

        // The `load` event and nothing else. img.decode() was here — it promises a
        // frame where the image is ready to paint, which is exactly what this wants
        // — but it stays pending for as long as the image has no data, and a
        // `loading="lazy"` image that hasn't been scrolled to has none. Most images
        // on the site are lazy, so a decode-gated reveal hangs on precisely the
        // images the gate is for, and awaiting one hard enough will hang the tab.
        // `load` has neither problem, and the browser has decoded by the time it
        // fires in practice.
        //
        img.addEventListener('load', done, {once: true});
        // An image that fails still has to clear — the alt text needs to be
        // readable, and the blur underneath it would make it illegible.
        img.addEventListener('error', done, {once: true});
    });
}

/**
 * Reveal every picture already in the document. Later arrivals (a Jonson answer,
 * anything else injected) call revealPictures() with their own subtree.
 */
export function mountPictures() {
    revealPictures(document);
}
