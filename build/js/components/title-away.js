// Tab title while the page is in the background.
//
// Switch to another tab and the title becomes a wave — a small nudge in the tab
// strip to come back. Coming back puts the real title straight back.
//
// A bare emoji, deliberately: a narrow background tab shows the favicon and a few
// characters at most, so a sentence is read as its first two words and a wave is
// read as a wave. Anything longer than this belongs in the page's real title.

const AWAY_TITLE = '👋';

export function mountTitleAway() {
    // Captured on the way out rather than once at mount: the title can change
    // between mount and the first blur, and restoring a stale one would be worse
    // than not swapping at all.
    let held = null;

    const onVisibility = () => {
        if (document.hidden) {
            if (held === null) held = document.title;
            document.title = AWAY_TITLE;
            return;
        }
        if (held !== null) {
            document.title = held;
            held = null;
        }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        // Unload can fire while hidden (closing a background tab), and a restored
        // bfcache page would come back wearing the away title.
        if (held !== null) {
            document.title = held;
            held = null;
        }
    };
}
