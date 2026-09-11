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

// How long the greeting stays open on its own before folding away. Two lines now,
// so long enough to read both; short enough that it never feels parked.
const GREETING_MS = 6000;

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
    const set = (open) => {
        root.classList.toggle('is-open', open);
        disc.setAttribute('aria-expanded', open ? 'true' : 'false');
        greeting.setAttribute('aria-hidden', open ? 'false' : 'true');
        clearTimeout(timer);
        if (open) timer = setTimeout(() => set(false), GREETING_MS);
    };

    disc.addEventListener('click', (e) => {
        e.stopPropagation();
        set(!root.classList.contains('is-open'));
    });
    // Pointing at the words while they're up keeps them up; the clock restarts
    // once the pointer leaves.
    greeting.addEventListener('pointerenter', () => clearTimeout(timer));
    greeting.addEventListener('pointerleave', () => {
        if (root.classList.contains('is-open')) timer = setTimeout(() => set(false), GREETING_MS);
    });
    document.addEventListener('click', (e) => {
        if (root.classList.contains('is-open') && !root.contains(e.target)) set(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root.classList.contains('is-open')) set(false);
    });
}
