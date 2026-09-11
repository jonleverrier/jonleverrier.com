/**
 * JONSON EXIT
 *
 * Where a conversation ended, and whether it ended by going somewhere.
 *
 * The tables already know where someone last SPOKE — that falls out of the last turn.
 * What they can't know without this is the difference between the two endings that
 * matter most:
 *
 *   closed the tab after two turns        → nothing followed
 *   clicked through to a case study       → Jonson did its job
 *
 * That distinction is the entire reason this file exists; without it "where did they
 * exit" only ever answers "on the homepage", which is where they already were.
 *
 * sendBeacon, not fetch: the page is going away, and a beacon is the one request the
 * browser promises to finish after unload. It is fire-and-forget by design — no
 * response, no error handling, nothing to await.
 *
 * `pagehide` rather than `beforeunload` or `unload`, both of which are unreliable on
 * mobile Safari and disable the back/forward cache. `visibilitychange` is the backstop
 * for the case pagehide never fires (an app switch that becomes a tab close).
 *
 * DOES NOTHING until a conversation exists. A visitor who never asks anything is a page
 * view, and page views are not what these tables are for.
 */

const ENDPOINT = '/jonson/exit';

// The last internal link pressed, captured on the way out so the beacon can say where
// they went. Cleared after use: a link pressed, then cancelled, then a tab closed ten
// minutes later should not be reported as the destination.
let destination = null;

function visitId() {
    try {
        return sessionStorage.getItem('jonson.sid') || '';
    } catch (e) {
        return '';
    }
}

// Only after a real conversation. `jonson.thread` is the snapshot thread-memory.js
// keeps; no snapshot means nothing was ever asked in this tab.
function hasConversation() {
    try {
        return !!sessionStorage.getItem('jonson.thread');
    } catch (e) {
        return false;
    }
}

let sent = false;

function report() {
    if (sent) return;
    const sid = visitId();
    if (!sid || !hasConversation()) return;
    sent = true; // once per page, whichever event wins the race

    try {
        const payload = new URLSearchParams();
        payload.set('sid', sid);
        payload.set('from', location.pathname);
        if (destination) payload.set('to', destination);
        // A Blob with the form content-type, because sendBeacon sends URLSearchParams
        // as text/plain, which Craft won't parse into body params.
        navigator.sendBeacon(
            ENDPOINT,
            new Blob([payload.toString()], {type: 'application/x-www-form-urlencoded'}),
        );
    } catch (e) {
        // The page is unloading. There is nowhere to report a failure to, and nothing
        // a visitor could do about it.
    }
}

export function mountJonsonExit() {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
        return () => {};
    }

    // Capture phase, so a handler that stops propagation (the nav panel and the
    // contact panel both do) can't hide the click from us.
    const onClick = (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        let url;
        try {
            url = new URL(a.getAttribute('href'), location.href);
        } catch (err) {
            return;
        }
        // Same-origin paths only — the same rule the rest of the site applies to
        // anything it records. An outbound link is not ours to log.
        destination = url.origin === location.origin ? url.pathname : null;
    };

    const onHide = () => report();
    const onVisibility = () => {
        if (document.visibilityState === 'hidden') report();
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
        document.removeEventListener('click', onClick, true);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
