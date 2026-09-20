/**
 * PINNED
 *
 * Which elements hold their place in the viewport while the page scrolls under them, and
 * which of those show the SAME THING every time they do.
 *
 *   node --test tools/audit/test/pinned.test.mjs
 *
 * WHY THIS EXISTS. The slice pass photographs a page a viewport at a time and stitches the
 * shots. Anything that stays put while the page scrolls is therefore photographed once per
 * slice, and lands in the image ten or twenty times. The capture used to ask
 * `position: fixed` and hide those. That question does not work, and all three of its
 * failures were measured on real pages:
 *
 *   - `sticky` is sometimes chrome and sometimes content. tpagency.com pins a
 *     scrollytelling panel across 4,000px — 45% of the page — that swaps one line of text
 *     per viewport. Hiding sticky elements took that region to pure black, which is the
 *     exact defect the slice pass exists to fix. jerseyfinance.com, hsbc.co.uk and
 *     klark.ai pin an ordinary NAV BAR with the same property, and not hiding those
 *     painted a header across the middle of a paragraph three to six times down the page.
 *   - `relative` is sometimes pinned. boondmanager.com's consent card mounts on a
 *     `div.axeptio_mount` that is a direct child of `<body>` and computes
 *     `position: relative`; it is held in the viewport by script. It painted twelve times,
 *     was recorded in no census, and `lib/consent.mjs` never even offered it as a banner
 *     candidate — a candidate had to sit under a `fixed`/`sticky` ancestor — so
 *     `consentBannerSeen` was false on a page with a consent card in plain sight.
 *   - No threshold on height or area separates the two, and none is guessed here.
 *
 * WHAT IS ASKED INSTEAD, and it is a measurement rather than a reading of the stylesheet:
 *
 *   1. PINNED: between two scroll offsets, did this element move LESS THAN HALF as far as
 *      the page did? An element carried by the scroll moves by exactly the scroll delta; a
 *      pinned one moves by nothing, or by the few pixels a sliding header travels. There is
 *      nothing in between on any page measured — see PIN_DRIFT_FRACTION.
 *   2. SAME PIXELS: rendered in ISOLATION at two offsets it was pinned across, does it draw
 *      the same thing? Same → repeating chrome, hide it after the first slice. Changing →
 *      a panel doing its job, keep it, because the visitor really does spend those
 *      viewports on it.
 *
 * EVERY WALK HERE CROSSES OPEN SHADOW ROOTS — see lib/shadow.mjs. Without that, a card a
 * page renders inside a web component is in no population at all: nothing measures it,
 * nothing decides it, nothing hides it, and it paints once per slice.
 *
 * THE CENSUS RUNS ONCE, BEFORE THE SLICING, and that bounds what any of this can reach. An
 * element that arrives during the scroll pass is measured by the census (which rides on that
 * pass) but was not there when the DECISION offsets were chosen, so the slice pass counts
 * what arrives after the decision as `lateArrivals` rather than pretending it judged them.
 * boondmanager.com's Axeptio card was the case this cost: it opens about eight seconds in,
 * three viewports down. It is now DISMISSED instead — lib/consent.mjs asks a second time
 * after the scroll pass — which is the honest answer for a consent wall and not one this
 * file could have given, because a banner is not repeating chrome, it is a wall a visitor
 * gets past.
 *
 * ISOLATION IS THE PART THAT MAKES THE ANSWER ABOUT THE ELEMENT. Cropping the element's box
 * out of the ordinary screenshot answers a different question — "do these pixels change" —
 * and the page scrolling behind a round icon or a translucent bar changes them every time.
 * Measured on jerseyfinance.com: its accessibility widget differs in 2.5% to 23% of its own
 * box between offsets, entirely in the transparent corners, and its header in 24%. Rendered
 * with the rest of the page hidden, both come out identical. See ISOLATE_ON.
 */

/**
 * How far an element may drift and still count as pinned, as a share of the scroll.
 *
 * Half. This is a two-way classification with nothing near the middle: on the six sites
 * measured, elements carried by the scroll move by the full delta (868–900px) and pinned
 * ones by 0–52px, the 52 being jerseyfinance.com's header sliding itself out of view while
 * the page moved 900. A fraction rather than a pixel count because the last scroll of a
 * page is clamped and can be as little as 70px.
 */
export const PIN_DRIFT_FRACTION = 0.5;

/** Sideways drift is not what scrolling does, so any of it is a carousel, not a pin. */
export const PIN_DRIFT_X_PX = 2;

/**
 * How much of the element's edge is left out of the pixel comparison.
 *
 * One pixel, and it is not cosmetic: a box's outermost row is where a neighbour's paint,
 * a border at a fractional offset and the antialiasing of both land. Measured on
 * jerseyfinance.com's accessibility widget — a 44x44 box whose right-hand column picks up
 * a sibling's tint — the difference between including that column and not is 2.3% against
 * 0%, which is the difference between calling it chrome and letting it repeat.
 */
export const COMPARE_INSET_PX = 1;

/**
 * How far the two renderings may be shifted against each other before comparing.
 *
 * A pinned element is not always at a whole pixel, and a header that has slid by 52.4px
 * renders its border on a different device row at the two offsets. One pixel each way,
 * best result wins; it cannot rescue a line of text that has been replaced.
 */
export const COMPARE_SHIFT_PX = 1;

/** Per-channel difference below which two pixels are the same pixel. */
export const CHANNEL_TOLERANCE = 8;

/**
 * The share of compared pixels that may differ and still be "the same pixels".
 *
 * MEASURED, on the six sites the regression was found on, with isolation and the inset
 * above. Repeating chrome — hsbc.co.uk's header and chat button, klark.ai's nav,
 * jerseyfinance.com's header and accessibility widget, boondmanager.com's nav and consent
 * card, switch.je's nav — comes out at 0.000%. The one pinned element that is content,
 * tpagency.com's scrollytelling panel, comes out at 4% to 8% depending on which line it
 * has swapped in. 1% sits an order of magnitude clear of both sides.
 *
 * IT IS NOT A SIZE OR SHAPE RULE AND MUST NOT BECOME ONE. The panel is caught because its
 * pixels change, not because it is large; a small pinned counter that ticks over would be
 * kept for the same reason, and correctly.
 */
export const SAME_PIXELS_MAX = 0.01;

/**
 * How many scroll-offset pairs the decision pass will visit.
 *
 * Each one costs two scrolls, two settles and two screenshots — about a second. One pair
 * decides every candidate on five of the six sites measured; the cap is here so that a
 * page whose chrome engages at many different depths cannot turn the decision into a
 * second full traverse of the page.
 */
export const MAX_DECISION_PAIRS = 3;

/**
 * Which of these elements held their place while the page scrolled from `before` to `after`.
 *
 * Boxes are `[id, x, y, w, h]` in VIEWPORT coordinates, as MEASURE_BOXES returns them.
 * `delta` is how far the page actually scrolled, which is not always what it was asked to.
 * An element only in one of the two lists is not an answer either way and is left out.
 */
export function pinnedBetween(before, after, delta) {
    if (!(delta > 0)) {
        return [];
    }
    const was = new Map(before.map((b) => [b[0], b]));
    const out = [];
    for (const box of after) {
        const previous = was.get(box[0]);
        if (!previous) continue;
        if (Math.abs(previous[2] - box[2]) >= delta * PIN_DRIFT_FRACTION) continue;
        if (Math.abs(previous[1] - box[1]) > PIN_DRIFT_X_PX) continue;
        out.push(box[0]);
    }

    return out;
}

/**
 * The part of the element that is on screen at BOTH offsets, in element-local pixels.
 *
 * Returned as where to read it from in each of the two images. Null when the element has
 * no common on-screen part — a header that has slid entirely above the viewport by the
 * second offset has nothing to compare, and saying so is better than comparing nothing.
 */
export function comparableRegion(was, now, width, height, shift = {dx: 0, dy: 0}) {
    const ax = was[0] + shift.dx;
    const ay = was[1] + shift.dy;
    const [bx, by, bw, bh] = now;
    const lx0 = Math.max(0, -ax, -bx) + COMPARE_INSET_PX;
    const lx1 = Math.min(was[2], bw, width - ax, width - bx) - COMPARE_INSET_PX;
    const ly0 = Math.max(0, -ay, -by) + COMPARE_INSET_PX;
    const ly1 = Math.min(was[3], bh, height - ay, height - by) - COMPARE_INSET_PX;
    if (lx1 <= lx0 || ly1 <= ly0) {
        return null;
    }

    return {
        ax: ax + lx0, ay: ay + ly0, bx: bx + lx0, by: by + ly0, w: lx1 - lx0, h: ly1 - ly0,
    };
}

/** Differing pixels over one region of two raw RGB buffers of the same size. */
function differingIn(a, b, region, width) {
    let differing = 0;
    for (let y = 0; y < region.h; y++) {
        const rowA = ((region.ay + y) * width + region.ax) * 3;
        const rowB = ((region.by + y) * width + region.bx) * 3;
        for (let x = 0; x < region.w; x++) {
            const pa = rowA + x * 3;
            const pb = rowB + x * 3;
            if (Math.abs(a[pa] - b[pb]) > CHANNEL_TOLERANCE
                || Math.abs(a[pa + 1] - b[pb + 1]) > CHANNEL_TOLERANCE
                || Math.abs(a[pa + 2] - b[pb + 2]) > CHANNEL_TOLERANCE) differing++;
        }
    }

    return differing;
}

/**
 * How much of this element's own rendering changed between two offsets.
 *
 * `a` and `b` are raw RGB buffers of two ISOLATED shots of the same size; `was` and `now`
 * are the element's viewport boxes in each. Returns `{fraction, differing, compared}`, or
 * null when there is nothing the two shots both contain.
 */
export function pixelChange(a, b, was, now, width, height) {
    let best = null;
    for (let dy = -COMPARE_SHIFT_PX; dy <= COMPARE_SHIFT_PX; dy++) {
        for (let dx = -COMPARE_SHIFT_PX; dx <= COMPARE_SHIFT_PX; dx++) {
            const region = comparableRegion(was, now, width, height, {dx, dy});
            if (!region) continue;
            const compared = region.w * region.h;
            const differing = differingIn(a, b, region, width);
            const got = {fraction: differing / compared, differing, compared, dx, dy};
            if (!best || got.fraction < best.fraction) best = got;
        }
    }

    return best;
}

/** Is this the same thing drawn twice? */
export const samePixels = (change) => change !== null && change.fraction <= SAME_PIXELS_MAX;

/**
 * Chrome, content, or neither — from the pixel comparison and the two viewport boxes.
 *
 * `change` is `pixelChange`'s answer (null when the two shots share no region); `was` and
 * `now` are the element's viewport boxes, `[x, y, w, h]`, or null where it could not be
 * described. Returns `{verdict, why}` where verdict is `chrome`, `content` or `undecided`,
 * and ONLY `chrome` is hidden from the capture.
 *
 * THE TWO WAYS TO SHARE NO REGION ARE NOT THE SAME THING, and treating them alike deleted
 * a footer. An element the page has scrolled PAST shows nothing at the second offset
 * because it has gone — jerseyfinance.com's header retracts on scroll down and is 58px
 * above the viewport once the page has moved 900, so no two offsets ever show the same
 * part of it. Left undecided it painted the few pixels it had not finished retracting into
 * the middle of a paragraph, so it is convicted.
 *
 * An element still sitting BELOW the viewport at both offsets has not gone anywhere. The
 * scroll never reached it, both shots contain nothing of it, and the comparison learned
 * nothing whatsoever. jersey.com is the case: its <footer>, 1440x821 at page y=15464, was
 * sampled at 12,600 and 13,500 and sat 1,064px below the fold at both. Convicted as chrome
 * it was hidden for every slice, and the capture came back with 1,694px of white where a
 * footer is — a deletion the page never made, invisible in meta.json unless you read the
 * hidden count. An element nobody could see is one nobody may convict.
 */
export function chromeVerdict(change, was, now, viewportHeight) {
    if (!was || !now) return {verdict: 'undecided', why: 'not measurable'};
    if (change) {
        return samePixels(change)
            ? {verdict: 'chrome', why: 'pixels'}
            : {verdict: 'content', why: 'pixels'};
    }

    const belowFold = (b) => b.box[1] >= viewportHeight;
    if (belowFold(was) && belowFold(now)) {
        return {verdict: 'undecided', why: 'below the fold at both offsets'};
    }

    return {verdict: 'chrome', why: 'off screen at one of the two offsets'};
}

/**
 * Which pairs of offsets would rather be used to decide a candidate.
 *
 * NOT THE ONE STARTING AT THE TOP OF THE PAGE, when there is any other. At scroll 0 a page
 * is in a state it is never in again: a back-to-top button has not faded in yet
 * (jerseyfinance.com — 93% of its pixels differ between "absent" and "there"), a nav has
 * not swapped to its scrolled theme yet (switch.je), an entrance transition is still
 * running. Comparing that state against a scrolled one measures the page waking up, not
 * whether the element repeats. The first pair is kept as a fallback because a header that
 * slides out of view is only ever comparable there.
 */
export function preferredPairs(pairs) {
    const later = pairs.filter((p) => p > 0);

    return later.length ? later : pairs;
}

/**
 * How many disjoint groups one offset pair may be photographed in.
 *
 * Candidates that overlap each other cannot share an isolated shot — see groupDisjoint —
 * so each group costs one more screenshot at each of the pair's two offsets. Four is well
 * past anything measured (the worst real case is two: a full-viewport pinned panel, and
 * everything else) and stops a page that pins twenty overlapping things from turning the
 * decision into forty screenshots.
 */
export const MAX_DISJOINT_GROUPS = 4;

/** Do these two boxes share a pixel? */
const overlaps = (a, b) => !(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0]
    || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]);

/**
 * Split candidates into groups that can be photographed together.
 *
 * TWO CANDIDATES THAT OVERLAP CANNOT SHARE AN ISOLATED SHOT, because each is then part of
 * the other's picture. Measured on the test page: a full-viewport pinned panel sits over a
 * fixed header at one of the two offsets and not at the other, so the header's own 60px
 * band came out 99.8% different — the panel's magenta against the header's red — and the
 * header was about to be called content and left to repeat down the page.
 *
 * Largest first, because the element most likely to cover others is the one that ends up
 * alone in a group of its own. `boxesAt` is a list of per-offset box lookups; an overlap at
 * EITHER offset separates them.
 */
export function groupDisjoint(ids, boxesAt, max = MAX_DISJOINT_GROUPS) {
    const area = (id) => boxesAt.reduce((most, at) => {
        const box = at.get(id);

        return Math.max(most, box ? box[2] * box[3] : 0);
    }, 0);
    const clash = (a, b) => boxesAt.some((at) => {
        const one = at.get(a);
        const other = at.get(b);

        return one && other && overlaps(one, other);
    });
    const groups = [];
    const left = [];
    for (const id of [...ids].sort((a, b) => area(b) - area(a))) {
        const group = groups.find((members) => !members.some((other) => clash(id, other)));
        if (group) group.push(id);
        else if (groups.length < max) groups.push([id]);
        else left.push(id);
    }

    return {groups, left};
}

/**
 * The fewest offset pairs that can decide every candidate, greedily.
 *
 * `want` maps a candidate id to the pairs that could decide it. Ties go to the earlier
 * pair so that the same page always chooses the same offsets.
 */
export function choosePairs(want, max = MAX_DECISION_PAIRS) {
    const chosen = [];
    const covered = new Set();
    for (let round = 0; round < max; round++) {
        const count = new Map();
        for (const [id, pairs] of want) {
            if (covered.has(id)) continue;
            for (const pair of pairs) count.set(pair, (count.get(pair) ?? 0) + 1);
        }
        if (count.size === 0) break;
        const [pair] = [...count.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
        const ids = [...want.entries()]
            .filter(([id, pairs]) => !covered.has(id) && pairs.includes(pair))
            .map(([id]) => id);
        chosen.push({pair, ids});
        for (const id of ids) covered.add(id);
    }

    return chosen.sort((x, y) => x.pair - y.pair);
}

/* ------------------------------------------------------------------ in the page */

/**
 * Open the record the pinned census keeps on the page. Runs IN the page.
 *
 * Elements are identified by an index into an array held here, never by a selector or an
 * attribute: an attribute is a DOM mutation a site's own scripts can see and react to, and
 * a selector cannot survive a framework re-render. `__auditPinned` is an expando on the
 * element — invisible to CSS, to `MutationObserver` and to `querySelectorAll` — so that
 * lib/consent.mjs and COLLECT_PINNED can ask an element whether it is pinned.
 */
export const BEGIN_PIN = () => {
    window.__auditPin = {els: [], idx: new WeakMap(), hidden: new Map(), iso: null};

    return 0;
};

/**
 * Every visible element's viewport box, with an identity that survives the next scroll.
 * Runs IN the page.
 *
 * Deliberately cheap: a bounding box the browser has already laid out, and nothing else.
 * No `getComputedStyle`, because this runs at every step of a pass that already walks the
 * page. Measured across the six sites: 74–463ms for a whole capture's worth of steps.
 *
 * The walk crosses open shadow roots — see lib/shadow.mjs. Without it a card rendered by a
 * web component is in no population, so nothing can measure it, decide it or hide it.
 */
export const MEASURE_BOXES = () => {
    const state = window.__auditPin;
    if (!state) return {scrollY: 0, boxes: []};
    const deep = window.__auditDeep;
    const boxes = [];
    for (const el of deep ? deep.all(document.body) : document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        let id = state.idx.get(el);
        if (id === undefined) {
            id = state.els.length;
            state.els.push(el);
            state.idx.set(el, id);
        }
        boxes.push([id, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]);
    }

    return {scrollY: Math.round(window.scrollY), boxes};
};

/** Remember that these elements held their place. Runs IN the page. */
export const MARK_PINNED = (ids) => {
    const state = window.__auditPin;
    if (!state) return 0;
    for (const id of ids) {
        const el = state.els[id];
        if (el) el.__auditPinned = true;
    }

    return ids.length;
};

/**
 * Tag, position and pinned ancestry for a few elements. Runs IN the page.
 *
 * The ancestry is what makes "maximal" answerable: hiding a pinned nav hides its logo too,
 * so the pixel test only ever has to run on the outermost pinned element of a subtree, and
 * a page with a pinned header of four hundred descendants costs one comparison, not four
 * hundred.
 */
export const DESCRIBE_PINNED = (ids) => {
    const state = window.__auditPin;
    // THE RECORD CAN BE GONE BY THE TIME THIS RUNS. A consent click that navigates is undone
    // by RELOADING the page, and lib/consent.mjs can now do that after the census has been
    // taken — which takes `window.__auditPin` and every element identity in it with it.
    // Reading `state.els` then throws, and would take down a capture that is otherwise fine.
    // An element nobody can describe is one nobody can decide, which is what null already
    // means here and what leaves the element alone. Reasoned from the reload, not observed
    // on a live page: no site in the sweep has a late banner whose accept control navigates.
    if (!state) return ids.map(() => null);
    const deep = window.__auditDeep;
    const above = deep ? deep.parent : (el) => el.parentElement;

    return ids.map((id) => {
        const el = state.els[id];
        if (!el || !el.isConnected) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const ancestors = [];
        for (let a = above(el); a && a !== document.documentElement; a = above(a)) {
            const pid = state.idx.get(a);
            if (pid !== undefined) ancestors.push(pid);
        }

        return {
            id,
            tag: el.tagName.toLowerCase(),
            position: cs.position,
            showing: cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0',
            ancestors,
            box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        };
    });
};

/**
 * Hide everything except these elements, over a plain background. Runs IN the page.
 *
 * FOUR RULES, EVERY ONE OF THEM LEARNED FROM A WRONG ANSWER ON A REAL PAGE:
 *
 *   - A CANDIDATE'S OWN SUBTREE IS NEVER TOUCHED. The first version walked into candidates
 *     and hid their children, and tpagency.com's pinned panel then rendered as an empty
 *     black strip at every offset — identical, and therefore about to be deleted as chrome.
 *     It is the element's own rendering, content included, that is in question.
 *   - EVERY OTHER ELEMENT IS HIDDEN EXPLICITLY, never by inheritance from an ancestor. The
 *     second version hid the ancestor chain and let inheritance do the rest; a page that
 *     reveals content with `.thing { visibility: visible }` — the ordinary scroll-reveal
 *     idiom — simply ignores an inherited hide, and jerseyfinance.com left a whole
 *     mega-menu, a CTA and a card row painting into the "isolated" shot. So `body *` is
 *     walked and everything outside the candidates is hidden where it stands.
 *   - `visibility`, NEVER `display`. Visibility takes an element out of the paint and
 *     leaves it in the layout, so nothing moves and every box stays where it was measured.
 *     It also leaves a site's OWN `visibility: hidden` alone inside the candidate, which a
 *     blanket `visibility: inherit` rule did not: jerseyfinance.com's mega-menu panels are
 *     hidden that way, and overriding it dragged four dropdown panels into the shot.
 *   - TRANSITIONS AND ANIMATIONS ARE STOPPED. A transition in flight beats `!important` in
 *     the cascade, so an element fading in ignores the hide entirely — measured on
 *     jerseyfinance.com's back-to-top button, whose inline style read `hidden` while its
 *     computed style read `visible`. Stopping them also means a pulsing chat bubble is not
 *     read as an element that shows different pixels.
 *
 * The canvas is forced to a flat white for the same reason the rest is hidden: a body
 * background that scrolls would otherwise be a difference the element did not make.
 */
export const ISOLATE_ON = (ids) => {
    const state = window.__auditPin;
    if (!state) return 0;
    // BOTH WALKS CROSS SHADOW BOUNDARIES. The keep set has to reach a candidate's shadow
    // descendants or they are hidden out of its own photograph, and the hide has to reach
    // everyone else's or a component paints into an "isolated" shot. See lib/shadow.mjs.
    const deep = window.__auditDeep;
    const under = (root) => (deep ? deep.all(root) : root.querySelectorAll('*'));
    if (!state.iso) {
        const style = document.createElement('style');
        style.textContent = 'html,body{background:#fff !important;background-image:none !important}'
            + '*,*::before,*::after{transition:none !important;animation:none !important}';
        document.head.appendChild(style);
        state.iso = {style, hidden: new Map(), shown: new Map()};
    }
    const remember = (el, into) => {
        if (into.has(el)) return false;
        into.set(el, {
            value: el.style.getPropertyValue('visibility'),
            priority: el.style.getPropertyPriority('visibility'),
        });

        return true;
    };
    const shown = [];
    const keep = new Set();
    for (const id of ids) {
        const el = state.els[id];
        if (!el || !el.isConnected) continue;
        shown.push(el);
        keep.add(el);
        for (const descendant of under(el)) keep.add(descendant);
    }
    for (const el of under(document.body)) {
        if (keep.has(el)) continue;
        if (remember(el, state.iso.hidden)) el.style.setProperty('visibility', 'hidden', 'important');
    }
    for (const el of shown) {
        remember(el, state.iso.shown);
        el.style.setProperty('visibility', 'visible', 'important');
    }

    return shown.length;
};

/** Put the page back exactly as it was before ISOLATE_ON. Runs IN the page. */
export const ISOLATE_OFF = () => {
    const state = window.__auditPin;
    if (!state?.iso) return 0;
    const put = (el, previous) => {
        if (previous.value === '') el.style.removeProperty('visibility');
        else el.style.setProperty('visibility', previous.value, previous.priority);
    };
    let n = 0;
    for (const [el, previous] of state.iso.shown) {
        put(el, previous);
        n++;
    }
    for (const [el, previous] of state.iso.hidden) {
        put(el, previous);
        n++;
    }
    state.iso.style.remove();
    state.iso = null;

    return n;
};

/**
 * Hide these elements for this slice. Runs IN the page, once per slice after the first.
 *
 * WITHOUT THIS, REPEATING CHROME APPEARS ONCE PER SLICE — twenty times down the stitched
 * image, painted over whatever the page really has at those rows. The first slice is the
 * one sighting where the element is where the page meant it to be, and every other is the
 * same element again.
 *
 * THE TRANSITION IS CANCELLED IN THE SAME BREATH, and without that this does not work at
 * all. A declaration in flight beats `!important` in the cascade, so an element carrying
 * `transition: visibility` that is mid-fade ignores the hide until the transition ends —
 * and the shot is taken immediately afterwards. MEASURED on jerseyfinance.com: its
 * accessibility widget and its back-to-top button both had an inline `visibility: hidden`
 * whose COMPUTED value was `visible`, and both painted a second time 900px down the image.
 * That is the defect the controller cropped and saw, and it survived the first version of
 * this fix with the element correctly identified as chrome and correctly asked to go.
 *
 * Idempotent and additive: run again, what is already hidden stays hidden with the inline
 * styles it arrived with.
 */
export const HIDE_PINNED = (ids) => {
    const state = window.__auditPin;
    if (!state) return 0;
    const deep = window.__auditDeep;
    const under = (root) => (deep ? deep.all(root) : root.querySelectorAll('*'));
    const properties = ['visibility', 'transition', 'animation'];
    let asked = 0;
    for (const id of ids) {
        const root = state.els[id];
        if (!root) continue;
        asked++;
        // THE SUBTREE TOO, ELEMENT BY ELEMENT. Hiding the root and trusting inheritance is
        // what the capture did before, and it does not work: a descendant carrying its own
        // `visibility: visible` — the ordinary way a widget or a scroll-reveal keeps itself
        // on screen — ignores an inherited hide completely. MEASURED on jerseyfinance.com:
        // with `div.userway_buttons_wrapper` hidden and every other descendant inheriting
        // it, `IMG.si_w` inside it still computed `visible`, and the accessibility widget
        // painted a second time 900px down the image.
        for (const el of [root, ...under(root)]) {
            if (!state.hidden.has(el)) {
                state.hidden.set(el, properties.map((name) => ({
                    name,
                    value: el.style.getPropertyValue(name),
                    priority: el.style.getPropertyPriority(name),
                })));
            }
            // RE-ASSERTED EVERY TIME, not set once. The page's own scripts write inline
            // styles to these elements as well, and switch.je's footer had ours overwritten
            // between the screenshot and the census — so the image had no footer and the
            // census had one, which is the contradiction this tool exists to avoid rather
            // than to create.
            el.style.setProperty('transition', 'none', 'important');
            el.style.setProperty('animation', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
        }
    }

    return asked;
};

/* --------------------------------------------------------------- the two passes */

/**
 * A fresh record for one capture's pinned census.
 *
 * `steps` are the scroll offsets the census visited, in order; pair `k` is the move from
 * `steps[k]` to `steps[k + 1]`. `boxes[k]` is every element's viewport box at `steps[k]`,
 * and `pinnedAt` maps an element to the pairs it held its place across.
 */
export const newCensus = () => ({steps: [], boxes: [], pinnedAt: new Map(), marked: 0});

/**
 * Fold one measurement into the census, and say which elements it found pinned.
 *
 * Only ever compares CONSECUTIVE measurements, because a pin has to hold continuously to
 * be one: an element that happens to sit at the same viewport position two viewports
 * apart, having been carried by the scroll in between, is not pinned and would be the one
 * false positive that deletes real content.
 */
export function recordStep(census, measured) {
    const boxes = new Map(measured.boxes.map((b) => [b[0], [b[1], b[2], b[3], b[4]]]));
    const previous = census.steps.length - 1;
    let pinned = [];
    if (previous >= 0 && measured.scrollY > census.steps[previous]) {
        const before = [...census.boxes[previous]].map(([id, b]) => [id, ...b]);
        pinned = pinnedBetween(before, measured.boxes, measured.scrollY - census.steps[previous]);
        const pair = previous;
        for (const id of pinned) {
            if (!census.pinnedAt.has(id)) census.pinnedAt.set(id, []);
            census.pinnedAt.get(id).push(pair);
        }
    }
    census.steps.push(measured.scrollY);
    census.boxes.push(boxes);

    return pinned;
}

/**
 * One viewport of scroll, measured, BEFORE the consent banner is dismissed.
 *
 * It buys one thing: `lib/consent.mjs` can then ask a control whether it sits inside
 * something that holds the viewport, rather than only whether a stylesheet says `fixed` or
 * `sticky`. boondmanager.com's consent card computes `position: relative` and is held
 * there by script, which is why `consentBannerSeen` was false on a page with a consent
 * card in plain sight.
 *
 * The settle is deliberately shorter than a slice's: this population is only ever used to
 * WIDEN the consent candidate set, never to narrow it, so anything a short dwell misses
 * falls back to the CSS test that was there before. A page whose banner locks scrolling
 * measures nothing here and loses nothing by it.
 */
export async function markEarlyPinned(page, {step, settleMs}) {
    const before = await step('measuring the page before the consent banner', () => page.evaluate(MEASURE_BOXES));
    await step('scrolling one viewport to see what holds its place', () => page.evaluate(
        () => window.scrollTo(0, window.innerHeight),
    ));
    await page.waitForTimeout(settleMs);
    const after = await step('measuring again', () => page.evaluate(MEASURE_BOXES));
    await step('scrolling back to the top', () => page.evaluate(() => window.scrollTo(0, 0)));
    await page.waitForTimeout(settleMs);
    const pinned = pinnedBetween(before.boxes, after.boxes, after.scrollY - before.scrollY);
    if (pinned.length) await step('marking what held its place', () => page.evaluate(MARK_PINNED, pinned));

    return pinned.length;
}

/** Was this element measured at both ends of this pair at all? */
function measuredAt(census, id, pair) {
    return Boolean(census.boxes[pair]?.get(id) && census.boxes[pair + 1]?.get(id));
}

/** …and is any of it on screen at both, so that there are pixels to compare? */
function decidableAt(census, id, pair, viewport) {
    if (!measuredAt(census, id, pair)) return false;

    return comparableRegion(
        census.boxes[pair].get(id), census.boxes[pair + 1].get(id), viewport.width, viewport.height,
    ) !== null;
}

/** The outermost pinned elements: the ones whose hiding would take their descendants too. */
function maximalPinned(described, census) {
    const pinned = new Set(census.pinnedAt.keys());

    return described.filter((d) => !d.ancestors.some((a) => {
        if (!pinned.has(a)) return false;
        const mine = new Set(census.pinnedAt.get(d.id));

        return census.pinnedAt.get(a).some((p) => mine.has(p));
    }));
}

/**
 * Which of the pinned elements are repeating chrome, decided on their own pixels.
 *
 * Visits at most MAX_DECISION_PAIRS pairs of offsets. At each one it photographs the
 * candidates in isolation twice and compares each one with itself. Returns the ids to hide
 * and a record of every decision it made, the number it made each one on, and the ones it
 * could not make at all — an element that was never measured at both ends of any pair is
 * left alone and recorded as undecided, because keeping something that repeats is a visible
 * flaw and deleting content is not.
 */
export async function decideChrome(page, census, {step, settleMs, viewport, shoot, raw}) {
    const record = {
        pinned: census.pinnedAt.size, maximal: 0, decided: 0, undecided: 0, chrome: 0, pairs: [], elements: [],
    };
    if (census.pinnedAt.size === 0) {
        return {chrome: [], record};
    }
    const described = (await step(
        'describing what held its place',
        () => page.evaluate(DESCRIBE_PINNED, [...census.pinnedAt.keys()]),
    )).filter(Boolean);
    const maximal = maximalPinned(described, census);
    record.maximal = maximal.length;

    // PIXELS FIRST, and a pair where there are none only as a fallback. See the off-screen
    // ruling in the comparison below for what such a pair can still settle.
    const want = new Map();
    for (const d of maximal) {
        const all = census.pinnedAt.get(d.id);
        const withPixels = all.filter((p) => decidableAt(census, d.id, p, viewport));
        const pairs = preferredPairs(withPixels.length ? withPixels : all.filter((p) => measuredAt(census, d.id, p)));
        if (pairs.length) want.set(d.id, pairs);
        else record.undecided++;
    }

    const chrome = [];
    const byId = new Map(described.map((d) => [d.id, d]));
    for (const {pair, ids} of choosePairs(want)) {
        const offsets = [census.steps[pair], census.steps[pair + 1]];
        const {groups, left} = groupDisjoint(ids, [census.boxes[pair], census.boxes[pair + 1]]);
        record.undecided += left.length;
        const shots = [];
        for (const at of offsets) {
            await step(`scrolling to ${at} to decide what repeats`, () => page.evaluate(
                (target) => window.scrollTo(0, target),
                at,
            ));
            await page.waitForTimeout(settleMs);
            const round = [];
            for (const group of groups) {
                await step(
                    `hiding everything but ${group.length} pinned elements`,
                    () => page.evaluate(ISOLATE_ON, group),
                );
                const buffer = await step(`photographing them at ${at}`, shoot);
                const boxes = await step('measuring them', () => page.evaluate(DESCRIBE_PINNED, group));
                await step('putting the page back', () => page.evaluate(ISOLATE_OFF));
                round.push({pixels: await raw(buffer), boxes});
            }
            shots.push(round);
        }
        record.pairs.push(offsets);
        for (let g = 0; g < groups.length; g++) {
            for (let k = 0; k < groups[g].length; k++) {
                const was = shots[0][g].boxes[k];
                const now = shots[1][g].boxes[k];
                const change = was && now
                    ? pixelChange(
                        shots[0][g].pixels, shots[1][g].pixels, was.box, now.box, viewport.width, viewport.height,
                    )
                    : null;
                // WHAT A CONVICTION COSTS, stated rather than hidden: an element that is
                // genuinely content and genuinely leaves the viewport between two offsets —
                // a sticky list heading pushed off by the next one — is hidden from the
                // slice it was last on screen in. It is bounded by the element's own height,
                // and both the alternative and the behaviour before this task lose it too.
                // See chromeVerdict for which silences convict and which do not.
                const {verdict, why} = chromeVerdict(change, was, now, viewport.height);
                const same = verdict === 'chrome';
                if (verdict === 'undecided') record.undecided++;
                else record.decided++;
                if (same) {
                    chrome.push(groups[g][k]);
                    record.chrome++;
                }
                const d = byId.get(groups[g][k]);
                record.elements.push({
                    tag: d?.tag ?? '?',
                    position: d?.position ?? '?',
                    box: now?.box ?? d?.box ?? null,
                    at: offsets,
                    compared: change ? change.compared : 0,
                    changed: change ? Number(change.fraction.toFixed(5)) : null,
                    why,
                    verdict,
                });
            }
        }
    }

    return {chrome, record};
}

/** Put back every element the slice pass hid, and forget it ever happened. Runs IN the page. */
export const RESTORE_HIDDEN = () => {
    const state = window.__auditPin;
    if (!state) return 0;
    let restored = 0;
    for (const [el, previous] of state.hidden) {
        for (const {name, value, priority} of previous) {
            if (value === '') el.style.removeProperty(name);
            else el.style.setProperty(name, value, priority);
        }
        restored++;
    }
    state.hidden = new Map();

    return restored;
};
