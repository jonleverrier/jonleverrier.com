/**
 * WEBGL PROBE
 *
 * Whether this capture could have rendered a WebGL hero at all, and whether the page
 * wanted one.
 *
 *   node --test tools/audit/test/webgl.test.mjs
 *
 * WHY THIS EXISTS, because it is not obvious and it cost a real finding to learn:
 * headless Chromium has no GPU and falls back to SwiftShader. Well-built sites check
 * for that and deliberately DECLINE to render — pushing tens of thousands of points
 * through a software rasteriser would be slower and uglier than not bothering. So the
 * page loads, reports success, and simply has a hole where its hero belongs.
 *
 * Every GPU-less renderer sees the same hole: this tool, PageSpeed Insights, Lighthouse,
 * social unfurl cards. Nothing is broken; the region genuinely did not render. What
 * would be broken is measuring that hole as empty space and putting a confident number
 * on it — a site whose hero IS its homepage would be told a quarter of its page is
 * nothing.
 *
 * So this never tries to force a render. It records what happened so the report can
 * decline to answer for that region.
 *
 * The limitation worth knowing: `requested` only catches a page that actually asked for
 * a context. A site that checks `navigator.gpu` or sniffs the UA and gives up BEFORE
 * touching getContext looks identical to a site with no WebGL at all. False negatives
 * are possible; false positives are not.
 */

/**
 * Renderer strings that mean "no GPU behind this".
 *
 * Matches what sites themselves test for — this list is deliberately the same shape as
 * the guard in a real site's hero code, because the point is to predict THEIR decision,
 * not to form our own opinion about the hardware.
 */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

/**
 * Is this renderer a software rasteriser?
 *
 * `null` means "cannot tell" and is NOT the same as `false`: a browser that withholds
 * WEBGL_debug_renderer_info leaves us guessing, and guessing "hardware" there would
 * silently restore the exact failure this module exists to surface.
 */
export function isSoftwareRenderer(renderer) {
    if (renderer === null) {
        return true; // no context at all — nothing can render, which is the strongest case
    }
    if (typeof renderer !== 'string' || renderer.trim() === '') {
        return null; // the extension was unavailable; unknown, not safe
    }

    return SOFTWARE_RENDERER.test(renderer);
}

/**
 * Runs in the page BEFORE its own scripts, recording every getContext type asked for.
 *
 * A wrapper, not a replacement: it records and delegates, so a page that depends on the
 * context it gets back is unaffected. Install with page.addInitScript().
 */
export const WEBGL_PROBE_INIT = () => {
    const seen = new Set();
    window.__auditWebglRequests = seen;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (typeof type === 'string' && /webgl|webgpu/i.test(type)) {
            seen.add(type);
        }

        return original.call(this, type, ...rest);
    };
};

/**
 * Read what the page asked for and what this browser can actually do.
 *
 * ORDER MATTERS INSIDE THE PAGE: the requested list is snapshotted BEFORE the throwaway
 * probe canvas is created, or our own getContext call lands in the very set we are
 * reading and every page looks like it wanted WebGL.
 */
export async function probeWebgl(page) {
    const raw = await page.evaluate(() => {
        const requested = [...(window.__auditWebglRequests ?? [])];

        let renderer = null;
        try {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
            if (gl) {
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
                // Hand the context back rather than waiting for GC — browsers cap how
                // many are live at once.
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
        } catch {
            renderer = null;
        }

        return {requested, renderer};
    });

    const software = isSoftwareRenderer(raw.renderer);

    return {
        renderer: raw.renderer,
        software,
        requested: raw.requested,
        // The whole point: the page wanted WebGL and this browser could not give it one
        // worth using, so something the page would normally draw is missing.
        blind: software !== false && raw.requested.length > 0,
    };
}

/** One line for a human, or null when there is nothing worth saying. */
export function webglWarning(webgl) {
    if (!webgl?.blind) {
        return null;
    }

    return `this page asked for ${webgl.requested.join('/')} and the browser offered only `
        + `${webgl.renderer || 'an unidentifiable renderer'} — a WebGL hero will not have `
        + 'rendered, so any region it occupies is unmeasured, not empty';
}
