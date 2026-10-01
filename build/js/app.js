/**
 * APP.JS
 *
 * Compiled via vite.config.js
 *
**/

import '../scss/app.scss';

import {mountCycleLogoDescription} from './components/cycle-logo-description.js';
import {mountPlaceholderCycle} from './components/placeholder-cycle.js';
import {mountJonson} from './components/jonson-ask.js';
import {mountGrid} from './components/jonson-grid.js';
import {mountObserver} from './components/observe.js';
import {mountPageTransition} from './components/page-transition.js';
import {restoreThread, finaliseRestore, mountThreadMemory} from './components/thread-memory.js';
import {mountVip} from './components/vip.js';
import {mountCaseStudyCursor} from './components/case-study-cursor.js';
import {mountStickyHeader} from './components/sticky-header.js';
import {mountTestimonials} from './components/testimonials.js';
import {mountMethod} from './components/method.js';
import {mountReadMore} from './components/read-more.js';
import {mountMetaMore} from './components/meta-more.js';
import {mountVideoAutoplay} from './components/video-autoplay.js';
import {mountLottieBlocks} from './components/lottie-block.js';
import {mountCodeBlocks} from './components/code-block.js';
import {mountAskHandoff, consumePendingQuestion, hasPendingQuestion} from './components/ask-handoff.js';
import {setupMarquees} from './components/clients-marquee.js';
import {mountPauseOffscreen} from './components/pause-offscreen.js';
import {mountContactForm} from './components/contact-form.js';
import {mountContactPanel} from './components/contact-panel.js';
import {mountNavPanel} from './components/nav-panel.js';
import {mountNotesNew} from './components/notes-new.js';
import {mountJonsonExit} from './components/jonson-exit.js';
import {mountPictures} from './components/picture.js';
import {mountFooterSections} from './components/footer-sections.js';
import {mountTitleAway} from './components/title-away.js';
import {mountToc} from './components/toc.js';
import {mountCaseToc} from './components/case-toc.js';
import {mountVoice} from './components/jonson-voice.js';
import {mountPrint} from './components/print.js';

import '../images/favicon.ico';

const elementHtml = document.documentElement;
elementHtml.classList.remove('no-js', 'is-loading');
elementHtml.classList.add('has-js', 'has-loaded');

// A VIP door changing hands, or closing, wipes the thread — before restoreThread below, so
// the wipe is what decides whether there's a thread to redraw at all.
mountVip();

// Redraw a conversation left behind on the way out. First, because it decides
// whether there's a hero to mount at all — restoring means the user is coming
// back to a thread, not arriving at the front door, so the tunnel intro would be
// both wrong and expensive.
const wasRestored = restoreThread();

// Zoom warp between pages (warp-out on leaving an internal link, warp-in on
// arrival). Set up first so a click during any intro still transitions.
const disposePageTransition = mountPageTransition();
window.addEventListener('beforeunload', disposePageTransition, {once: true});

// Default no-op tunnel: if there's no hero (or reduced motion), the warp just
// calls straight through to its completion callback.
let tunnel = {dispose: () => {}, warpOut: (cb) => { if (cb) cb(); }};
// The exit animation for whichever backdrop is on screen, set once it has mounted.
// Null means there isn't one and Jonson should just open.
let backdropWarp = null;
// A question typed into an ask bar on another page. Like a restored thread, it means
// the visitor isn't arriving at the front door — they've already asked something — so
// the hero intro is skipped and we open straight into the conversation. Peeked rather
// than consumed: the question itself is submitted later, after everything is mounted.
const handedOver = hasPendingQuestion();
const hero = (wasRestored || handedOver) ? null : document.querySelector('[data-frontdoor]');

// Not mounting the tunnel stops it ANIMATING, but the markup is still there and would
// sit on screen until the question submits at the end of this file. Hide it now, as
// restoreThread does — and only once we know there's a thread to show instead, so a
// missing view can never leave a blank slab.
if (handedOver && !wasRestored) {
    const handoffView = document.querySelector('[data-jonson-view]');
    const handoffDoor = document.querySelector('[data-frontdoor]');
    if (handoffView && handoffDoor) {
        handoffDoor.hidden = true;
        handoffView.hidden = false;
        document.documentElement.classList.add('is-jonson', 'is-conversing');
    }
}
// The hero is the tunnel intro, and its drift speed is dragged down by scroll
// position. On back-navigation the browser restores the previous scroll, which
// would land us scrolled-down and make the tunnel crawl instead of launching.
// Opt the homepage out of scroll restoration and pin to the top so back-nav
// always plays the launch at full speed, like a hard refresh. Other pages keep
// the browser's default scroll restoration.
//
// A restored thread also wants manual: the scroll position it left off at is in
// the snapshot, and finaliseRestore puts it back once the content has laid out.
if ('scrollRestoration' in history) {
    history.scrollRestoration = (hero || wasRestored) ? 'manual' : 'auto';
}
if (hero) {
    window.scrollTo(0, 0);

    // The tunnel is imported ON DEMAND, and only when its canvas is actually in the
    // markup. It pulls in three — and a static import here put three in the bundle
    // EVERY page loads, to power a backdrop the template currently doesn't render
    // (see `backdrop` in _views/single/home/default.twig, presently 'hero'). The hero
    // below was already deferred for exactly this reason; the deferral saved nothing
    // while this import was hoisting the same library into the main chunk.
    if (hero.querySelector('[data-tunnel-canvas]')) {
        import('./components/tunnel.js').then(({mountTunnel}) => {
            tunnel = mountTunnel(hero);
            window.addEventListener('beforeunload', tunnel.dispose, {once: true});
        });
    }

    // The point-cloud backdrop, when the template asks for it instead of the tunnel
    // canvas (see _views/single/home/default.twig). mountTunnel above still runs
    // either way; with no [data-tunnel-canvas] present it simply has nothing to draw.
    //
    // Imported on demand, not at the top of this file. hero.js pulls in three, which
    // is far larger than everything else here put together, and it's wanted on one
    // page — a static import would put it in the bundle every other page loads too.
    const heroCloud = document.querySelector('[data-hero]');
    if (heroCloud) {
        // Mounted immediately, NOT deferred until the arrival warp finishes. That
        // deferral was here and it was the wrong call: measured, the import and mount
        // together cost about 135ms, of which 57ms is main-thread work — three or four
        // frames. Waiting out the 640ms warp-in to dodge that traded a hitch nobody
        // would notice for two thirds of a second of blank slab, which everybody does.
        //
        // Tried a second time once head.twig began preloading hero.js and three, on
        // the reasoning that the bytes now arrive early so a deferral would only move
        // the main-thread work rather than the download. It moves nothing worth
        // having, because there is nothing there to move:
        //
        //   · three is parsed on a BACKGROUND thread — 190ms at v8.parseOnBackground,
        //     not on the one that matters.
        //   · createHero does not run until the 293kB point-cloud binary lands, which
        //     is ~3.6s in. By then the page has been interactive for three seconds.
        //
        // Measured with requestIdleCallback and a 400ms ceiling, 4 first-visit runs
        // each, built bundle, 1.6Mbps/150ms/4x CPU:
        //
        //     TBT      174ms -> 163ms    ranges 97-209 vs 155-187, i.e. noise
        //     canvas  3618ms -> 3765ms   the backdrop just turns up later
        //
        // The binary is the long pole. Anything done to the mount is rearranging what
        // happens after it — if this wants to be faster, that 293kB is the thing.
        //
        // AFTER FIRST PAINT, though — and that is for PageSpeed, not for the visitor.
        // Lighthouse (and so PageSpeed Insights) does not throttle a real load. It
        // loads at full speed and then SIMULATES a slow phone, charging the LCP with
        // every request that started before the LCP element was seen to paint. The
        // <h1> is the LCP element, so with hero.js, three and the binary requested
        // up front it was billed for ~420kB of backdrop: simulated LCP 4.05s, mobile
        // score 86, against a real throttled LCP of ~0.4s. Waiting for the first
        // paint keeps every one of those requests out of the h1's account.
        //
        // Local Lighthouse, mobile, 3 runs each (it reproduced PageSpeed's 4.05s/86):
        //
        //     head.twig preloads + mount now     score 86     LCP 4.05s
        //     preloads removed                   score 94-95  LCP 2.70s
        //     preloads removed + this wait       score 98     LCP 1.95s
        //
        // The price, on 1.6Mbps/150ms/4x CPU with a GPU, 5 runs each: LCP unchanged at
        // 0.41s, the animated hero visible at 3.92s instead of 3.55s.
        //
        // 'paint' is the entry type that carries first-contentful-paint. A browser
        // without it mounts straight away, as before. A tab opened in the background
        // does not paint until it is shown, so neither does the hero; nothing is lost.
        const firstPaint = new Promise((painted) => {
            const hasPainted = () => performance.getEntriesByName('first-contentful-paint').length > 0;
            if (typeof PerformanceObserver !== 'function'
                || !PerformanceObserver.supportedEntryTypes?.includes('paint')
                || hasPainted()) {
                painted();
                return;
            }
            const po = new PerformanceObserver(() => {
                if (hasPainted()) {
                    po.disconnect();
                    painted();
                }
            });
            po.observe({type: 'paint', buffered: true});
        });
        firstPaint
            // hero-mount decides GPU / no GPU / no WebGL first, and only the GPU branch
            // downloads three — see the top of hero-mount.js.
            .then(() => import('./components/hero-mount.js'))
            .then(({mountHero}) => mountHero(heroCloud))
            .then((cloud) => {
                window.addEventListener('beforeunload', cloud.dispose, {once: true});
                // Whichever backdrop is live owns the exit beat. Swapping the function
                // in here rather than passing it to mountJonson directly, because the
                // cloud arrives asynchronously and Jonson is mounted below — without
                // this a question asked before the cloud finished loading would take
                // the tunnel's no-op instead.
                //
                // Torn down as soon as the flight lands. Hiding the front door stops it
                // DRAWING — the observer sees a display:none element and the loop skips
                // its body — but the rAF callback still runs every frame and the WebGL
                // context keeps 37k points of buffers on the GPU for as long as the
                // visitor reads. Nothing brings the door back without a page load (the
                // logo wipe navigates), so there's nothing to keep it alive for.
                backdropWarp = (done) => cloud.warpOut(() => {
                    if (done) done(); // reveals the thread and hides the door first
                    cloud.dispose();
                });
            })
            .catch(() => {
                // WebGL unavailable, the binary missing, three failing to load — the
                // section still has its title and ask bar, so a dead backdrop is a
                // blank panel rather than a broken page. Nothing to announce.
            });
    }
}

const cycleLogoDescription = document.querySelector('[data-cycle-logo-description]');
if (cycleLogoDescription) {
    const disposeCycleLogoDescription = mountCycleLogoDescription(cycleLogoDescription);
    window.addEventListener('beforeunload', disposeCycleLogoDescription, {once: true});
}

// Every ask bar cycles its prompts through its placeholder: the front door's and the
// thread's (the homepage set), and a content page's (its own, see _components/ask).
const disposePlaceholderCycles = [...document.querySelectorAll('[data-placeholder-cycle]')].map(mountPlaceholderCycle);
window.addEventListener('beforeunload', () => disposePlaceholderCycles.forEach((d) => d()), {once: true});

// Resolved at call time, not bound now: the point cloud loads asynchronously and may
// not have set `backdropWarp` yet when this runs. Falls back to the tunnel's, which is
// itself a no-op when there's no canvas to animate.
const disposeJonson = mountJonson({
    warpOut: (done) => (backdropWarp || tunnel.warpOut)(done),
});
window.addEventListener('beforeunload', disposeJonson, {once: true});

// Interactive dot grid on a static content page (the .c-jonson version is
// mounted inside jonson-ask). Tan dots to read on the cream slab.
const contentGrid = document.querySelector('[data-content-grid]');
if (contentGrid) {
    const disposeContentGrid = mountGrid(contentGrid, {
        // White, not the taupe of the spine. A dot DARKER than the slab competes with
        // the prose on top of it — turn it down far enough to stop competing and it
        // disappears. Lifting the grid off the eggshell instead means the same trick
        // the olive slab plays: the dots read as texture in the ground rather than
        // marks over it, so they can be strong without touching legibility.
        dotRgb: '255, 255, 255',
        // The grid's presence is dialled up mainly on SIZE, not alpha: white can only
        // go to 1, and 1 leaves the sweep and the cursor lift nothing to add — they'd
        // clip and the grid would sit dead at full brightness. So the resting dot is
        // bigger (1.6 vs the conversation's 1.1) and held just below full, leaving
        // both effects room to reach it.
        baseAlpha: 0.8,
        sweepAlpha: 0.2,   // 0.8 + 0.2 = solid white at the band's peak
        nearAlpha: 0.2,    // ditto under the cursor
        dotRadius: 1.6,
        // The hovered dot lands at 2.0px — the size the conversation's hover reaches
        // (its 1.1 + 0.9), which is what sets the scale for both surfaces. The SWELL
        // is therefore smaller here, not bigger: this grid starts from a larger
        // resting dot, so matching the peak means it has less distance to travel.
        // Follow the peak, not the swell — the swell is what's left over once the
        // resting size is chosen, and copying 0.9 across put the hovered dots visibly
        // past the conversation's.
        nearRadius: 0.4,
    });
    window.addEventListener('beforeunload', disposeContentGrid, {once: true});
    // A successful contact submit pulses the dots (contact-form dispatches the event).
    document.addEventListener('contact:success', () => {
        if (typeof disposeContentGrid.pulse === 'function') disposeContentGrid.pulse();
    });
}

// Contact form: AJAX submit (progressive enhancement) — intercept, POST via fetch,
// render success/errors in place with no reload. Falls back to a native submit if
// fetch fails. The plain form still works with JS off.
// Every contact form on the page: the contact page's own, and the one inside the
// contact panel that every page carries.
const disposeContactForms = [...document.querySelectorAll('[data-form]')].map(mountContactForm);
const disposeContactForm = () => disposeContactForms.forEach((d) => d());

// The contact side panel: opens on any click through to the contact page.
const disposeContactPanel = mountContactPanel();
const disposeNavPanel = mountNavPanel();
// "New since you were last here" on the Notes links, and a dot on the burger.
const disposeNotesNew = mountNotesNew();
window.addEventListener('beforeunload', disposeNotesNew, {once: true});
// Records how a conversation ended — and whether it ended by going somewhere.
// Mounted on every page, not just the homepage: a thread survives navigation, so the
// exit can happen anywhere. It does nothing until a conversation exists.
//
// NOT disposed on beforeunload, for exactly the reason thread-memory isn't (see the
// note further down): its whole job happens during unload, and beforeunload fires
// ~100ms BEFORE pagehide — the usual cleanup would tear the listener down just before
// the moment it exists to handle.
mountJonsonExit();
window.addEventListener('beforeunload', disposeContactForm, {once: true});

// Static clients marquees present at load (e.g. the contact page). Jonson's own
// marquees stream in later and are set up by jonson-ask.js; this only touches ones
// already in the DOM. Idempotent.
setupMarquees(document);

// Pause continuous animations (marquee scroll, method shimmer) while off-screen.
const disposePauseOffscreen = mountPauseOffscreen();
window.addEventListener('beforeunload', disposePauseOffscreen, {once: true});

// Ask bar on a content page — hands the question to the homepage rather than
// posting, since Jonson can only render an answer there.
const disposeAskHandoff = mountAskHandoff();
window.addEventListener('beforeunload', disposeAskHandoff, {once: true});

// Testimonial sliders, delegated from the document — one handler covers answers,
// restored threads and static pages (the caseStudy single) alike.
const disposeTestimonials = mountTestimonials(document);
window.addEventListener('beforeunload', disposeTestimonials, {once: true});

// Method timelines, likewise delegated from the document: answers inject them per
// response, the About page ships one in the markup.
const disposeMethod = mountMethod(document);
window.addEventListener('beforeunload', disposeMethod, {once: true});

// Collapse any [data-read-more] prose to its opening paragraph. Runs here, not in
// CSS, so the content is readable with JS off rather than truncated with no toggle.
const disposeReadMore = mountReadMore(document);
window.addEventListener('beforeunload', disposeReadMore, {once: true});

// Cap any [data-meta-more] list (the case study's Role row) at its first N items.
// Same bargain as above: the full list is in the HTML, this hides the tail on mount.
const disposeMetaMore = mountMetaMore(document);

// Dictation in the ask fields. Adds nothing where the browser can't do it (see
// components/jonson-voice.js), so Firefox and anything older never sees a mic.
const disposeVoice = mountVoice(document);
window.addEventListener('beforeunload', disposeMetaMore, {once: true});

// Case study clips: loop while on screen, pause off it. The markup has no `autoplay`
// attribute, so nothing downloads until the block is actually reached.
const disposeVideoAutoplay = mountVideoAutoplay(document);
window.addEventListener('beforeunload', disposeVideoAutoplay, {once: true});

// Lottie blocks on a case study: player + JSON fetched on approach, played on view.
const disposeLottieBlocks = mountLottieBlocks(document);
window.addEventListener('beforeunload', disposeLottieBlocks, {once: true});

// Code blocks: served plain, coloured by a Shiki chunk fetched on approach.
const disposeCodeBlocks = mountCodeBlocks(document);
window.addEventListener('beforeunload', disposeCodeBlocks, {once: true});

// Develop each blur-up image in over its placeholder once it has decoded. Early,
// and NOT deferred behind anything: the placeholder is showing from first paint,
// so every moment before this runs is a moment a cached image sits blurred.
mountPictures();

// Fold the footer's two link columns away on a phone. Runs on load rather than on
// demand: it closes them, and a footer that opens its sections a beat after the page
// settles is worse than one that was never going to fold at all.
const disposeFooterSections = mountFooterSections(document);
window.addEventListener('beforeunload', disposeFooterSections, {once: true});

// Reveal-on-scroll for any element with `js-observe` (adds `is-inview`).
const disposeObserver = mountObserver();
window.addEventListener('beforeunload', disposeObserver, {once: true});

// Header travels between a resting height and a tighter stuck height; this only
// tells CSS which of the two applies (position: sticky can't express both).
const disposeStickyHeader = mountStickyHeader();
window.addEventListener('beforeunload', disposeStickyHeader, {once: true});

// Pointer-following badge over the case study cards. Delegated, so it picks up
// cards that stream in with later answers. No-ops entirely on touch.
const disposeCardCursor = mountCaseStudyCursor();
window.addEventListener('beforeunload', disposeCardCursor, {once: true});

// Swap the tab title to an invitation while the visitor is off in another tab.
const disposeTitleAway = mountTitleAway();
window.addEventListener('beforeunload', disposeTitleAway, {once: true});

// Prepares the document for printing: takes every lazy image off its leash (WebKit
// does not force-load them for a print the way Chrome does).
const disposePrint = mountPrint();
window.addEventListener('beforeunload', disposePrint, {once: true});

// "On this page" nav on a note: marks the section in view (see components/toc.js).
const disposeToc = mountToc();
// The case study section strip — the second TOC, for pages made of pictures.
// Returns a no-op where there is no strip, so it costs nothing on every other page.
const disposeCaseToc = mountCaseToc();
window.addEventListener('beforeunload', disposeCaseToc, {once: true});
window.addEventListener('beforeunload', disposeToc, {once: true});

// Snapshot the thread on the way out, and wipe it on the deliberate reset
// gestures (the logo and the conversation's own back control — both marked
// data-wipe-thread). Browser-back and a logo click land on the same URL, so the
// intent has to be taken on the click; arrival at `/` just restores if it can.
// Deliberately NOT disposed on beforeunload like the other components. This one's
// whole job happens during unload, and beforeunload fires ~100ms BEFORE pagehide —
// so the usual cleanup pattern would tear the save listener down just before the
// moment it exists to handle, and the snapshot would never be written.
mountThreadMemory();

// Re-arm anything the restored markup had bound per-element, and put the scroll
// position back. Last, so every component it leans on is already mounted.
finaliseRestore();

// A question handed over from an ask bar on another page. After finaliseRestore, so
// it lands on top of any restored conversation rather than racing it.
consumePendingQuestion();

// Showboard, the screenshot stage at /tools/showboard (components/showboard.js). Imported
// only where the page carries it: it pulls in three, which no other page outside the hero pays for.
const showboardRoot = document.querySelector('[data-showboard]');
if (showboardRoot) {
    import('./components/showboard.js').then(({mountShowboard}) => {
        const dispose = mountShowboard(showboardRoot);
        window.addEventListener('beforeunload', dispose, {once: true});
    });
}
