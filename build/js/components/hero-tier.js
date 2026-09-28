/**
 * What is behind WebGL on this canvas: a real GPU ('hardware'), a software rasteriser
 * the browser fell back to ('software'), or nothing at all ('none').
 *
 * A throwaway context, read and immediately released. Works on an HTMLCanvasElement
 * (hero.js's main-thread fallback) and on an OffscreenCanvas (hero-probe.worker.js),
 * and imports nothing, so the probe worker stays a few hundred bytes rather than
 * pulling three in behind it.
 *
 * 'none' also covers an OffscreenCanvas that cannot do WebGL at all (Safari 16.4 has
 * OffscreenCanvas but only 2D) — which is why hero.js treats anything but a definite
 * answer from the worker as "ask again on the main thread", never as "no WebGL".
 */
export function probeTier(canvas) {
  try {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'none';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
    // Hand the context back rather than waiting for GC — browsers cap how many are
    // live at once, and the real renderer wants one straight after this.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(name) ? 'software' : 'hardware';
  } catch {
    return 'none';
  }
}
