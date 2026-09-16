/**
 * VIP
 *
 * A visitor who came in through /vip/{slug} holds a cookie, and the server does
 * the rest: primes Jonson with Jon's private note on them (modules/jonson/
 * services/Vip) and renders the strip along the bottom of every page
 * (_components/vip-strip). Nothing here decides any of that.
 *
 * The one thing only the browser can do: notice the door changing. The
 * conversation lives under a cid in localStorage and a snapshot in sessionStorage,
 * neither of which the server touches — so a second VIP link opened in the same
 * browser would carry the first person's thread, and Jonson's history of it, into
 * the second person's visit; and a door Jon has DISABLED would leave a thread
 * running in which Jonson is still talking to that person by name, and still
 * suggesting where they might go next, long after the note was pulled from its
 * prompt. Remember which door this browser last came through; when it differs
 * from what the strip shows now — another door, or none — wipe the thread before
 * anything restores it. Same as the logo does, for the same reason: a fresh
 * conversation for whoever this now is.
 *
 * Runs BEFORE restoreThread (see app.js): the wipe mints a new cid, which is what
 * makes restoreThread throw the old snapshot away rather than redraw it.
 */

import {wipeThread} from './thread-memory.js';

const KEY = 'jonson.vip'; // the uid of the last VIP door this browser came through
// The door this VISIT has already been greeted by. sessionStorage, not localStorage,
// and that is the whole decision: the greeting should open itself once when someone
// arrives, not on every page they then read, and not never again after the first time
// they ever followed the link. A visit is the unit that matches "first use" — come back
// next week on the same 30-day cookie and being welcomed again is right, where being
// welcomed on page four of one sitting is not. (thread-memory keeps its snapshot in
// sessionStorage for the same reason: a visit is the natural life of a conversation.)
const GREETED_KEY = 'jonson.vip.greeted';

// How long the greeting stays open on its own before folding away. Two lines now,
// so long enough to read both; short enough that it never feels parked.
const GREETING_MS = 6000;
// How often the crown hops on its own while the greeting is shut. Long enough that it
// reads as the badge catching your eye rather than as something animating at you.
const HOP_EVERY_MS = 10000;
// How long after the page settles the greeting opens itself on arrival — see
// greetOnArrival.
const GREETING_ON_ARRIVAL_MS = 900;

export function mountVip() {
    const strip = document.querySelector('[data-vip]');
    const now = strip ? (strip.dataset.vip || '') : '';
    if (strip) mountGreeting(strip);
    let last = '';
    try {
        last = localStorage.getItem(KEY) || '';
    } catch (e) { /* private mode — nothing remembered, so nothing to compare */ }

    // A different door from last time, or the door gone: the conversation so far
    // was had as that VIP, and it doesn't carry over. Gone means Jon disabled the
    // entry (the cookie itself lasts 30 days, and a thread only lives three
    // hours on the server, so an expired cookie never finds a thread to wipe).
    // Only a door → no-door change wipes; a plain visitor who was never a VIP
    // has nothing remembered and is left alone.
    if (last && now !== last) wipeThread();

    if (now !== last) {
        try {
            if (now) localStorage.setItem(KEY, now);
            else localStorage.removeItem(KEY);
        } catch (e) { /* private mode */ }
    }
}

/**
 * The greeting behind the disc. Press to unfold it, press again (or Escape, or a
 * click anywhere else) to fold it; left alone it folds itself after GREETING_MS.
 * State lives on the root's `is-open` class (the CSS animates off it) and is
 * mirrored to aria-expanded / aria-hidden so the words are announced only while
 * they're on screen.
 */
function mountGreeting(root) {
    const disc = root.querySelector('[data-vip-disc]');
    const greeting = root.querySelector('.c-vip__greeting');
    if (!disc || !greeting) return;

    let timer = 0;
    // Set while the pointer is over the badge. The fold-away clock is not merely paused
    // in that case but not started at all, so a timer that fires from somewhere else —
    // the auto-open below, say — cannot close the pill under a pointer that is resting
    // on it.
    let held = false;

    const arm = () => {
        clearTimeout(timer);
        if (!held) timer = setTimeout(() => set(false), GREETING_MS);
    };

    const set = (open) => {
        root.classList.toggle('is-open', open);
        disc.setAttribute('aria-expanded', open ? 'true' : 'false');
        greeting.setAttribute('aria-hidden', open ? 'false' : 'true');
        clearTimeout(timer);
        if (open) arm();
    };

    disc.addEventListener('click', (e) => {
        e.stopPropagation();
        set(!root.classList.contains('is-open'));
    });

    // The whole badge, not just the pill. Hovering the DISC used to leave the clock
    // running, so the greeting folded away under a pointer that was sitting on the
    // thing that opened it — and the disc is where the pointer already is, having just
    // pressed it. `root` is the disc and the pill and the gap between them.
    root.addEventListener('pointerenter', () => {
        held = true;
        clearTimeout(timer);
    });
    root.addEventListener('pointerleave', () => {
        held = false;
        if (root.classList.contains('is-open')) arm();
    });
    document.addEventListener('click', (e) => {
        if (root.classList.contains('is-open') && !root.contains(e.target)) set(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root.classList.contains('is-open')) set(false);
    });

    greetOnArrival(root, set);
    mountIdleHop(root);
}

/**
 * Open the greeting by itself the first time this visit sees this door — so a visitor
 * who has just followed a personal link is welcomed rather than shown a badge to press.
 *
 * Keyed by the door's uid, so a second VIP link opened in the same visit greets again
 * as the new person. Nothing remembered means greet: a browser that refuses storage
 * gets the greeting on each page rather than never, which is the kinder failure of the
 * two, and the pill folds itself away regardless.
 *
 * A beat's delay so it UNFOLDS on arrival rather than being there when the page paints
 * — the animation is the greeting, and a pill that is simply already open reads as a
 * banner. Long enough to clear the page transition; short enough to still belong to
 * the arrival.
 */
function greetOnArrival(root, set) {
    const door = root.dataset.vip || '';
    if (!door) return;

    let greeted = '';
    try {
        greeted = sessionStorage.getItem(GREETED_KEY) || '';
    } catch (e) { /* storage refused — greet, as above */ }

    if (greeted === door) return;

    try {
        sessionStorage.setItem(GREETED_KEY, door);
    } catch (e) { /* nothing to remember it with */ }

    setTimeout(() => set(true), GREETING_ON_ARRIVAL_MS);
}

/**
 * The crown hops by itself every ten seconds or so.
 *
 * A CLASS TOGGLE, not an infinite CSS animation. The alternative was one long cycle
 * with the hop squeezed into its first nine percent, which would mean a second copy of
 * the keyframes with every percentage rescaled — and an element held on a compositor
 * layer continuously for a 900ms effect. This file's neighbours have been bitten by
 * exactly that: the method shimmer and the clients marquee both re-rasterised in Safari
 * because something animated forever. Toggling reuses the existing keyframes untouched.
 *
 * The class comes off on animationend rather than a second timer, so the two can't
 * drift apart if a frame is late.
 */
function mountIdleHop(root) {
    const crown = root.querySelector('.c-vip__crown');
    if (!crown) return;

    // Nothing to catch the eye with if the visitor has asked for stillness.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let timer = 0;

    const hop = () => {
        // Not while the greeting is open — the same crown is mid-hop from that already,
        // and restarting the animation underneath it would cut it off.
        if (!root.classList.contains('is-open') && !document.hidden) {
            root.classList.add('is-hopping');
        }
        timer = setTimeout(hop, HOP_EVERY_MS);
    };

    crown.addEventListener('animationend', () => root.classList.remove('is-hopping'));

    // Stop the clock off-screen: a background tab throttles timers anyway, but this way
    // the badge is not mid-hop on a tab nobody is looking at, and the first hop after
    // coming back is a fresh ten seconds rather than whatever the throttle left over.
    document.addEventListener('visibilitychange', () => {
        clearTimeout(timer);
        if (!document.hidden) timer = setTimeout(hop, HOP_EVERY_MS);
    });

    timer = setTimeout(hop, HOP_EVERY_MS);
}
