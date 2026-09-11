// Autoplay a case study clip while it's on screen, pause it when it isn't — and hide
// its controls, since a silent loop is a moving image rather than a player.
//
// The `autoplay` ATTRIBUTE is deliberately not used: it starts the download and the
// playback at page load, wherever the video happens to sit. Urban's clip is 19MB and
// lives most of a page down. So the markup ships inert — poster, controls, and
// `preload="none"` — and this starts it once it comes into view: the download when it
// arrives, the playback when there's a frame to show. See sync() for why those are two
// steps and not one.
//
// Both of those work in the same direction, and it's the direction Read more goes: the
// served page is the WORKING one (a poster with a player), and JS takes things away.
// No JS, no observer, or an autoplay refusal, and the visitor still has a video they
// can start. Hide the controls in the markup instead and every one of those cases is a
// dead poster.
//
// Muted is not a style choice, it's the price of entry — browsers block autoplay with
// sound. Set here as well as in the markup, because a browser that restored a previous
// unmuted state would otherwise have play() rejected.

const SEL = '[data-autoplay-video]';

// Enough of the clip on screen to be worth playing. Low, because these are wide and
// short: a 16/9 video most of the way up the viewport is still mostly off it.
const THRESHOLD = 0.25;

function setup(video) {
    if (video._autoplayVideo) return;

    video.muted = true; // see the note above — autoplay is refused without it

    // A visitor who has asked for less motion decides for themselves — leave the
    // shipped controls alone and set nothing else up.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // From here we're going to try to autoplay, so the controls come off: a silent
    // clip looping in place is a moving image, not something to operate. They go back
    // on below if the browser refuses.
    video.controls = false;

    let onScreen = false;
    let waiting = false; // a loadeddata listener is armed, so don't stack another
    let userPaused = false; // stopped BY THE VISITOR, which sync() must not undo

    // play() rejects on its own terms, and the common ones aren't bugs: Safari refuses
    // ALL autoplay in Low Power Mode, even a silent muted clip, and a per-site setting
    // can do the same. There's no retry that would help — so hand the visitor the
    // controls instead. Without that they'd be left with a poster and no way in.
    const attempt = () => {
        const played = video.play();
        if (played) played.catch(() => { video.controls = true; });
    };

    // The other half of that: the controls are only there to offer a way in, so once
    // the visitor has taken it this is the same silent loop as every other clip on the
    // page and the bar comes off again. It can't be trimmed to just the play button —
    // `controlsList` is Chromium-only and the media-control pseudo-elements are private
    // — so it's the whole bar or none of it, and none of it is the house style.
    //
    // Nothing to undo when it pauses: a clip scrolled out of view is paused by sync()
    // with no one looking at it, and scrolling back runs attempt(), which hands the
    // controls back above if the browser refuses a second time.
    const onPlay = () => { video.controls = false; };

    // Taking the bar away takes the pause button with it, so the clip itself becomes the
    // target — click to stop, click to start. Same gesture either way, which is why this
    // is a toggle rather than a pause.
    //
    // Bails while the controls are up, because then the bar IS the interface: in the Low
    // Power Mode case a click on its play button reaches this listener too, and without
    // the guard it would read the now-playing clip and pause it right back.
    //
    // A stop here is different in kind from the one sync() does for a clip that has
    // scrolled off — that one is housekeeping and resumes on the way back, this one was
    // asked for and has to survive scrolling away, returning, and switching tabs. Hence
    // the flag, cleared only by asking for it to play again.
    const onClick = () => {
        if (video.controls) return;
        if (video.paused) {
            userPaused = false;
            attempt();
        } else {
            userPaused = true;
            video.pause();
        }
    };

    // THE FETCH AND THE PLAYBACK ARE SEPARATE STEPS, and the gap between them is the
    // whole reason this isn't one call.
    //
    // Safari drops the poster the moment play() is called — before there is any frame
    // to put in its place. Call it on a clip that has no data, which is exactly what
    // `preload="none"` guarantees, and the <video> has nothing to paint for as long as
    // the download takes. On Urban's 19MB clip that was a blank box for seconds,
    // arrived at by anyone who scrolled down quickly. Measured in Safari: readyState 0,
    // paused false, poster gone.
    //
    // So coming into view starts the DOWNLOAD, and `loadeddata` starts the PLAYBACK.
    // The poster stays up throughout, because nothing has asked to play yet — a still
    // of the clip is a perfectly good thing to be looking at while it loads, which is
    // what it was prepared for.
    //
    // `loadeddata` (HAVE_CURRENT_DATA) and not `canplay` (HAVE_FUTURE_DATA): the
    // invariant is only ever "there is a frame to paint", and the first frame is
    // exactly that. Waiting for the buffer beyond it would start later for no gain —
    // a clip that then stalls holds its last frame, it doesn't go blank, which is the
    // only failure this is guarding against.
    const onFrameReady = () => {
        waiting = false;
        // It may have scrolled away while the file was coming down.
        if (onScreen && !document.hidden) attempt();
    };

    // A clip that can't load never reaches loadeddata, so the controls this module took
    // away have to come back some other way. Under the old flow play() rejected and
    // restored them; now play() is never reached, and without this a broken source
    // leaves a poster with no way in — the exact state the shipped markup avoids.
    const onError = () => { video.controls = true; };

    const sync = () => {
        if (onScreen && !document.hidden && !userPaused) {
            // HAVE_CURRENT_DATA — there is a frame to paint, so play() can't blank it.
            if (video.readyState >= 2) {
                // Coming back to it starts it again from the top, so the clip is always
                // seen from its opening rather than resumed mid-shot.
                //
                // Gated on `paused`, because this runs on EVERY intersection and
                // visibility change, not just the ones that stopped it — scrolling
                // slowly across the 0.25 threshold re-fires the observer while the clip
                // is still playing, and ungated that would snap it back to the start
                // under the visitor mid-play.
                if (video.paused) video.currentTime = 0;
                attempt();
                return;
            }

            // Nothing has been requested yet (`preload="none"`), so ask — once, hence
            // the flag: sync() runs on every intersection and visibility change, and
            // load() restarts the fetch from the top each time it's called.
            if (!waiting) {
                waiting = true;
                video.addEventListener('loadeddata', onFrameReady, {once: true});

                video.preload = 'auto';
                // Flipping preload is enough to start the download in Safari, but not
                // dependably elsewhere, so ask outright. Gated on readyState 0 — no
                // frame, currentTime 0, nothing buffered — because load() resets all
                // three, and a clip that has already played and been scrolled back to
                // must not be dragged back to the start.
                //
                // NOT gated on `networkState === NETWORK_EMPTY`, which reads like the
                // right test and isn't: Safari reports NETWORK_IDLE on an untouched
                // `preload="none"` element, so that guard skipped the call on the one
                // browser this whole path exists for.
                if (video.readyState === 0) video.load();
            }
        } else if (!video.paused) {
            video.pause();
        }
    };

    video.addEventListener('error', onError);
    video.addEventListener('play', onPlay);
    video.addEventListener('click', onClick);

    const io = new IntersectionObserver(([e]) => {
        onScreen = e.isIntersecting;
        sync();
    }, {threshold: THRESHOLD});
    io.observe(video);

    // A hidden tab still decodes a playing video. The observer can't see that — it
    // reports on layout, not on whether anyone is looking.
    const onVisibility = () => sync();
    document.addEventListener('visibilitychange', onVisibility);

    video._autoplayVideo = () => {
        io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        video.removeEventListener('loadeddata', onFrameReady);
        video.removeEventListener('error', onError);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('click', onClick);
        video.pause();
        video.controls = true; // back to the served state, as the markup shipped it
        video._autoplayVideo = null;
    };
}

/** Wire every [data-autoplay-video] inside `root`. Idempotent. */
export function mountVideoAutoplay(root = document) {
    if (!root) return () => {};

    const scope = root === document ? document : root;
    scope.querySelectorAll(SEL).forEach(setup);

    return () => {
        scope.querySelectorAll(SEL).forEach((video) => {
            if (video._autoplayVideo) video._autoplayVideo();
        });
    };
}
