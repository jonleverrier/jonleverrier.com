/**
 * SHADOW
 *
 * One walk of the page that does not stop at a component boundary.
 *
 *   node --test tools/audit/test/shadow.test.mjs
 *
 * WHY. Every population this tool takes — the DOM census, the pinned census, the isolation
 * pass, the hide, the consent finder — was a `document.querySelectorAll('body *')`, and
 * that walk STOPS DEAD at a shadow root. An element inside a web component is in none of
 * them: not in `rects.json`, not in the pinned census, not hidden when it repeats, not
 * offered to the consent pass. It is still PAINTED, so the image has it and every record
 * of the page denies it — the one shape this tool must never produce.
 *
 * MEASURED ON boondmanager.com, which is why this exists. Its Axeptio consent card mounts
 * on `div.axeptio_mount`, a direct child of `<body>` computing `position: relative` and
 * sized 1440x0. Inside it is `div.needsclick`, whose OPEN shadow root holds the card:
 *
 *     div.ax-widget-container   [absolute  420x223]   the card
 *   < div.ax-website-overlay    [fixed    1440x0  ]
 *   < #shadow-root (open)
 *   < div.needsclick            [static   1440x0  ]
 *   < div.axeptio_mount         [relative 1440x0  ]
 *   < body
 *
 * The light-DOM walk sees the three 1440x0 wrappers, drops all of them for having no area,
 * and never reaches the 420x223 card. The card painted twelve times down a 10,567px capture
 * — 1.6% of the page — while `rects.json` held not one rect for it and `consentBannerSeen`
 * reported `false` on a page carrying a consent wall in plain sight.
 *
 * TWO PRIMITIVES, because the failure has two shapes:
 *
 *   - `all(root)` — every element under `root`, crossing into open shadow roots. What the
 *     census walks.
 *   - `parent(el)` — the element above `el`, crossing OUT of a shadow root to its host. An
 *     ancestor walk hits `parentElement === null` at a shadow boundary and stops, so
 *     "is this control inside something banner-shaped", "is this element clipped by an
 *     ancestor" and "which pinned element is the outermost" all answered as if the
 *     component were the whole document.
 *
 * WHY IT IS INSTALLED ON THE PAGE RATHER THAN IMPORTED. Everything above runs INSIDE the
 * browser, via `page.evaluate`, which serialises the function's source and drops its
 * module scope: an in-page function cannot call anything it did not define itself. The
 * choice was one copy of this walk in each of the seven places that need it, or one copy
 * installed on the page for all of them to call. `page.addInitScript` puts it in every
 * frame before the page's own scripts run, which is also what makes it available to the
 * consent pass inside a CMP's iframe.
 *
 * `lib/capture.mjs` ASSERTS IT IS THERE, once, before it measures anything. Each in-page
 * caller also falls back to the light-DOM walk if it is missing, so nothing crashes — but
 * a capture that silently stopped piercing would report smaller numbers with no sign that
 * anything had changed, and that is the failure mode this whole file is about.
 *
 * WHAT IT STILL CANNOT SEE, declared rather than worked around:
 *
 *   - A CLOSED shadow root. `element.shadowRoot` is null for one by design, and there is no
 *     way to reach it from script. Nothing here can find that content and nothing pretends
 *     to; it is the same blind spot as a cross-origin iframe.
 *   - Content in an iframe of any kind. Frames are walked separately, by whoever is asking.
 */

/**
 * Define the walk on the page. Passed to `page.addInitScript`, so it runs in every frame
 * before that frame's own scripts.
 *
 * `window.__auditDeep` is the only name it takes. An expando rather than an attribute or a
 * class, for the reason lib/pinned.mjs gives about `__auditPin`: an attribute is a DOM
 * mutation the site's own scripts can see and react to, and this tool measures pages, it
 * does not change them.
 */
export const SHADOW_INIT = () => {
    /**
     * Every element under `root`, in document order, descending into open shadow roots.
     *
     * `root` may be a Document, a ShadowRoot or an Element. An Element's OWN shadow content
     * comes first, because that is the content the element actually renders; its light
     * children follow. A host's shadow content is emitted immediately after the host, which
     * keeps the walk deterministic and close to the order the light-DOM walk had.
     */
    const all = (root, out = []) => {
        if (root.shadowRoot) all(root.shadowRoot, out);
        for (const el of root.querySelectorAll('*')) {
            out.push(el);
            if (el.shadowRoot) all(el.shadowRoot, out);
        }

        return out;
    };

    /**
     * The element above this one, crossing out of a shadow root to its host.
     *
     * `parentElement` is null for the top of a shadow tree — its parent is the ShadowRoot,
     * which is a DocumentFragment, not an Element. `parentNode.host` is the way across.
     */
    const parent = (el) => {
        if (el.parentElement) return el.parentElement;
        const above = el.parentNode;

        return above && above.host ? above.host : null;
    };

    window.__auditDeep = {all, parent};
};

/**
 * Is the walk installed, and how much of this page is behind a component boundary?
 * Runs IN the page.
 *
 * Both answers from one round trip, because both are asked once per capture and neither is
 * worth a second one. `installed` is what lib/capture.mjs refuses to continue without;
 * `hosts` and `inShadow` go into `meta.capture.shadow` so that "this page has no web
 * components" and "the walk stopped working" are different numbers on every site rather
 * than the same silence.
 */
export const SHADOW_CENSUS = () => {
    const deep = window.__auditDeep;
    if (!deep) {
        return {installed: false, hosts: 0, elements: 0, inShadow: 0};
    }
    const elements = deep.all(document.body);

    return {
        installed: true,
        hosts: elements.filter((el) => el.shadowRoot).length,
        elements: elements.length,
        inShadow: elements.filter((el) => el.getRootNode() !== document).length,
    };
};
