/**
 * WEBGL PROBE
 *
 * Whether this capture could have rendered a WebGL hero at all, and whether the page
 * wanted one.
 *
 *   node --test tools/audit/test/webgl.test.mjs
 *
 * WHY THIS EXISTS: a page can load perfectly, report success, and still have a hole
 * where its hero belongs — and nothing about the capture looks wrong.
 *
 * THE BROWSER IS NOT THE PROBLEM, and the first version of this file got that wrong.
 * Headless Chromium renders WebGL fine through SwiftShader: verified directly, shaders
 * compile and link and a drawn triangle reads back the right pixels. Software rendering
 * is slow, not absent. So "no GPU" does NOT imply "nothing rendered", and a check built
 * on the renderer string warns about every site that draws happily in software.
 *
 * What actually happens is a decision by the PAGE. Sites with heavy scenes probe the
 * renderer, see SwiftShader, and decline — pushing tens of thousands of points through a
 * software rasteriser would be slower and uglier than not bothering. That is a correct
 * call on their part, and PageSpeed Insights and Lighthouse see the same hole for the
 * same reason, which is what confirms it is the page choosing rather than the tool
 * failing.
 *
 * So the signal here is a context that was asked for and never drawn with. That is the
 * decision itself, and it holds whatever the renderer turns out to be. The renderer is
 * recorded only to explain WHY in the warning text — it is never the evidence.
 *
 * Nothing here tries to force a render. It records what happened so the report can
 * decline to answer for that region rather than measuring a hole as empty space: a blank
 * region segments perfectly and conserves area, so a site whose hero IS its homepage
 * would otherwise be told a quarter of its page is nothing.
 *
 * The limitations worth knowing, both false NEGATIVES — a page that draws is never
 * wrongly flagged:
 *
 *   - `requested` only catches a page that called getContext. One that checks
 *     `navigator.gpu`, sniffs the UA, or gives up before touching a canvas looks
 *     identical to a page with no WebGL at all.
 *   - A page that draws one frame and then abandons the scene counts as having drawn.
 */

import {printable} from './printable.mjs';

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
 * Runs in the page BEFORE its own scripts, recording what was asked for and whether
 * anything was ever actually drawn.
 *
 * THE DRAW COUNT IS THE REAL SIGNAL, and the renderer is not. Headless Chromium renders
 * WebGL perfectly well through SwiftShader — verified directly: shaders compile and link,
 * and a drawn triangle reads back the right pixels. So "software renderer" does NOT mean
 * "nothing rendered", and treating it that way warns about every site that draws happily
 * in software.
 *
 * What actually happened on the site that prompted this is narrower: it PROBED the
 * renderer, saw SwiftShader, and chose not to draw. A context with zero draw calls is
 * that decision, made visible — and it holds whatever the renderer turns out to be.
 *
 * Wrappers, not replacements: each records and delegates, so a page depending on what it
 * gets back is unaffected. Install with page.addInitScript().
 */
export const WEBGL_PROBE_INIT = () => {
    const seen = new Set();
    window.__auditWebglRequests = seen;
    window.__auditWebglDraws = 0;

    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (typeof type === 'string' && /webgl|webgpu/i.test(type)) {
            seen.add(type);
        }

        return original.call(this, type, ...rest);
    };

    // Every call that puts geometry on screen. A scene that renders calls one of these
    // per frame; a scene that gave up calls none of them ever.
    const methods = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
        if (!proto) continue;
        for (const name of methods) {
            const fn = proto[name];
            if (typeof fn !== 'function') continue;
            proto[name] = function (...args) {
                window.__auditWebglDraws++;

                return fn.apply(this, args);
            };
        }
    }
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
        const draws = window.__auditWebglDraws ?? 0;

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

        return {requested, renderer, draws};
    });

    return {
        renderer: raw.renderer,
        // Reported for the human reading the warning, never used to decide it. It is the
        // usual REASON a page declines to draw, which makes it worth printing and
        // useless as evidence.
        software: isSoftwareRenderer(raw.renderer),
        requested: raw.requested,
        draws: raw.draws,
        // Asked for a context and never drew a single thing with it. That is the page
        // deciding not to render, and it is true regardless of renderer.
        blind: raw.requested.length > 0 && raw.draws === 0,
    };
}

/** One line for a human, or null when there is nothing worth saying. */
export function webglWarning(webgl) {
    if (!webgl?.blind) {
        return null;
    }

    // BOTH OF THESE ARE THE PAGE'S OWN STRINGS. The renderer looks like a driver fact
    // and is not: a page can replace WebGLRenderingContext.prototype.getParameter and
    // return whatever it likes, and the requested types are the arguments it passed to
    // getContext. This line is printed on a terminal, so neither reaches it raw.
    const because = webgl.software === true
        ? ` (likely because the renderer is ${printable(webgl.renderer, 80)})`
        : '';

    return `this page asked for ${printable(webgl.requested.join('/'), 80)} but never drew with it${because}`
        + ' — whatever it would have rendered is missing, so any region it occupies is'
        + ' unmeasured, not empty';
}
