// Thread memory — the conversation survives leaving the homepage.
//
// Jonson's own memory was never the fragile part: the `cid` in localStorage keys
// the server-side history/transcript, and it already outlives any navigation. So
// walking off to a case study and back leaves the model remembering everything
// while the screen shows an empty tunnel — it doesn't forget, it only looks like
// it has. This closes that gap by restoring the *view* to match.
//
// Why a snapshot rather than a re-fetch: the rendered thread is already sitting in
// the DOM, so storing it costs nothing and needs no endpoint. A replay endpoint
// would have to hand the uncapped transcript back out keyed on a client-asserted
// cid, which is a security surface that doesn't currently exist. Nothing worth
// opening for a redraw we can do locally.
//
// sessionStorage, deliberately, because its lifetime IS the rule we want:
//   same tab   → you went somewhere and came back  → restore
//   new tab    → a new visit                       → the front door
// No heuristics needed to tell those apart; the storage does it.
//
// Wiping is explicit and belongs to the user: the logo and the conversation's
// own back control both mean "take me to the homepage", and the homepage is the
// front door — tunnel, clean slate. That's why the wipe happens on the CLICK and
// not on arrival at `/`: browser-back and a logo click land on the same URL and
// must do opposite things, so intent has to be captured while we still have it.

import {setupMarquees} from './clients-marquee.js';

const KEY = 'jonson.thread';
const CID = 'jonson.cid';
// Matches AskController::CACHE_TTL (3h). Past it the server has forgotten the
// conversation, so restoring the view would draw a thread Jonson can no longer
// discuss — visibly fine, quietly amnesiac. Better to show the front door.
const TTL_MS = 10800 * 1000;
// Snapshot format version. The stored value is raw panel MARKUP, styled by whatever
// CSS the page later loads — so a class rename ships new CSS to an old snapshot and
// the replayed thread renders against rules that no longer match it. That fails
// quietly and weirdly (a list losing `list-style: none` shows stray bullets; a card
// losing its z-index rule sinks under the hover-blur layer) rather than erroring, so
// it's easy to mistake for a CSS bug.
//
// BUMP THIS whenever the markup a panel emits changes — class names, nesting,
// wrappers. A mismatch throws the snapshot away and shows the front door, which is
// the same call the TTL and cid checks already make: a stale view is worse than none.
// 3: the feature card's <h3> moved OUT of .c-case-study__reveal so it shows without
//    a hover. A v2 snapshot styled by v3 CSS is the failure this guard exists for and
//    it looks like a CSS bug: the logo and client obey the new rules and appear, while
//    the title sits in the collapsed box the new markup no longer puts it in.
const SNAPSHOT_VERSION = 3;

const read = () => {
    try {
        const raw = sessionStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
};

const cid = () => {
    try {
        return localStorage.getItem(CID) || '';
    } catch (e) {
        return '';
    }
};

let restored = false;

/**
 * Redraw a stored conversation. Must run BEFORE the tunnel and Jonson are
 * mounted — it decides whether there's a hero intro to play at all.
 * Returns true if a thread was restored.
 */
export function restoreThread() {
    const snap = read();
    if (!snap || !snap.html) return false;

    // Discard when the server-side conversation is gone or has been replaced:
    // a stale view is worse than no view, because it makes a promise about what
    // Jonson remembers that Jonson can't keep.
    if (Date.now() - (snap.at || 0) > TTL_MS) return clearThread(), false;
    if (snap.cid && snap.cid !== cid()) return clearThread(), false;
    // Written by an older build, whose markup this build's CSS no longer styles.
    // (Absent on snapshots from before versioning existed — also a mismatch.)
    if (snap.v !== SNAPSHOT_VERSION) return clearThread(), false;

    const view = document.querySelector('[data-jonson-view]');
    const thread = document.querySelector('[data-jonson-thread]');
    const frontDoor = document.querySelector('[data-frontdoor]');
    if (!view || !thread) return false;

    thread.innerHTML = snap.html;

    // Match the state mountJonson's enter() leaves behind, minus the warp — there
    // was no hero to fly through, so animating one in would be a lie about where
    // the user just came from.
    const root = document.documentElement;
    root.classList.add('is-jonson', 'is-conversing');
    if (frontDoor) frontDoor.hidden = true;
    view.hidden = false;

    restored = true;
    return true;
}

/**
 * Re-arm behaviours the streamed content had set up for itself. Run AFTER the
 * other components are mounted.
 *
 * The in-thread click handlers are delegated from the thread container
 * (jonson-ask.js:495), so chips and testimonial sliders survive the innerHTML
 * swap untouched. Only things bound per-element need redoing.
 */
export function finaliseRestore(snap = read()) {
    if (!restored) return;

    const thread = document.querySelector('[data-jonson-thread]');
    if (!thread) return;

    // Reveal-on-scroll already fired for all of this the first time round. Mark it
    // seen so it doesn't replay a stagger of animations over content the user has
    // read and is returning to.
    thread.querySelectorAll('.js-observe').forEach((el) => el.classList.add('is-inview'));

    setupMarquees(thread);

    // Testimonial sliders position their slides on resize; nudge them so restored
    // ones lay out rather than waiting for the user to change the window.
    window.dispatchEvent(new Event('resize'));

    if (snap && typeof snap.scrollY === 'number') {
        window.scrollTo(0, snap.scrollY);
    }
}

/** Forget the conversation on this tab — the view only; see wipeThread. */
export function clearThread() {
    try {
        sessionStorage.removeItem(KEY);
    } catch (e) { /* private mode — nothing stored to clear */ }
}

/**
 * Full reset. Minting a fresh cid is the entire server-side wipe: every key
 * (jonson-history, jonson-transcript, jonson-answer:*, jonson-shown:*) derives
 * from it, so a new id is a new bucket for all of them at once and the orphans
 * age out on their own TTL. No endpoint, no delete path.
 *
 * Note this abandons rather than erases: the old transcript lingers in Craft's
 * cache until it expires. Fine for a reset; not sufficient for a "forget me".
 */
export function wipeThread() {
    clearThread();
    try {
        localStorage.setItem(CID, crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    } catch (e) { /* private mode — the id was per-load anyway */ }
}

export function mountThreadMemory() {
    const thread = document.querySelector('[data-jonson-thread]');
    // Disarmed by a wipe. A flag rather than removing listeners, because the save
    // hangs off two events (pagehide and visibilitychange) and unhooking only one
    // leaves the other free to write the snapshot straight back after a reset.
    let armed = true;

    // Marquees are built by JS — a run gets cloned and `is-ready` set — and none of
    // that should be stored. Restoring a pre-built strip means the clone comes back
    // as duplicate content that the rebuild then clones AGAIN. Snapshot the markup as
    // the server rendered it and let clients-marquee.js build from scratch on load.
    const pristineHtml = () => {
        const copy = thread.cloneNode(true);
        copy.querySelectorAll('.c-clients, .c-case-studies--marquee').forEach((m) => {
            m.classList.remove('is-ready');
            m.style.removeProperty('--c-clients-duration');
            m.style.removeProperty('--c-case-studies-duration');
            // Keep only the first run in each track; the rest are clones.
            m.querySelectorAll('.c-clients__track, .c-case-studies__track').forEach((track) => {
                const runs = [...track.children];
                runs.slice(1).forEach((r) => r.remove());
            });
        });
        return copy.innerHTML;
    };

    const save = () => {
        if (!armed || !thread || !thread.children.length) return;
        try {
            sessionStorage.setItem(KEY, JSON.stringify({
                v: SNAPSHOT_VERSION,
                html: pristineHtml(),
                scrollY: Math.round(window.scrollY),
                at: Date.now(),
                cid: cid(),
            }));
        } catch (e) {
            // Quota — a long thread with panels can be large. Losing the snapshot
            // degrades to today's behaviour rather than breaking anything.
        }
    };

    // pagehide over beforeunload: it fires on mobile tab-switching and on the
    // bfcache path, both of which beforeunload can skip entirely.
    window.addEventListener('pagehide', save);
    // Belt and braces for mobile, where a tab can be discarded without pagehide.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') save();
    });

    // The wipe gestures. Normally not preventDefault'd — the link still navigates,
    // we only take the intent on the way past.
    const onClick = (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const el = e.target.closest && e.target.closest('[data-wipe-thread]');
        if (!el) return;

        wipeThread();
        armed = false; // don't let the way out write the thread straight back

        // The logo points at the homepage, so from a restored conversation it
        // targets the URL we're already on — and browsers don't reliably tear down
        // and rebuild the document for a same-URL navigation. The wipe would land
        // (new cid, snapshot gone) while the thread stayed on screen: Jonson has
        // forgotten, the screen hasn't. Force the reload so the reset is visible.
        let target;
        try {
            target = new URL(el.getAttribute('href'), location.href);
        } catch (err) {
            return; // unparseable — let the browser do whatever it was going to
        }
        if (target.href === location.href) {
            e.preventDefault();
            location.reload();
        }
    };
    document.addEventListener('click', onClick);

    return () => {
        armed = false;
        window.removeEventListener('pagehide', save);
        document.removeEventListener('click', onClick);
    };
}
