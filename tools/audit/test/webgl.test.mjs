/**
 * WEBGL PROBE
 *
 * The renderer classifier and the warning it produces.
 *
 *   node --test tools/audit/test/webgl.test.mjs
 *
 * No browser here on purpose: the decision worth testing is "does this renderer string
 * mean a site will refuse to draw", which is pure string work. The live end of it is
 * covered by the AUDIT_LIVE capture test.
 *
 * The renderer strings below are REAL, copied from actual runs rather than invented,
 * because the whole classifier is a bet on what these strings look like in the wild.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isSoftwareRenderer, webglWarning} from '../lib/webgl.mjs';

// Verbatim from headless Chromium on this machine — the string that started all this.
const HEADLESS = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)';

test('the real headless Chromium renderer is classified as software', () => {
    assert.equal(isSoftwareRenderer(HEADLESS), true);
});

test('a real GPU is not classified as software', () => {
    assert.equal(isSoftwareRenderer('ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)'), false);
    assert.equal(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)'), false);
});

test('the other software rasterisers are caught too', () => {
    assert.equal(isSoftwareRenderer('Mesa/X.org llvmpipe (LLVM 15.0.7, 256 bits)'), true);
    assert.equal(isSoftwareRenderer('Microsoft Basic Render Driver'), true);
});

test('no context at all counts as software — nothing can render', () => {
    assert.equal(isSoftwareRenderer(null), true);
});

// This is the distinction that matters most in the file: a browser withholding
// WEBGL_debug_renderer_info leaves us guessing, and guessing "hardware" would restore
// the silent failure the module exists to prevent.
test('an unavailable renderer string is unknown, NOT hardware', () => {
    assert.equal(isSoftwareRenderer(''), null);
    assert.equal(isSoftwareRenderer('   '), null);
    assert.notEqual(isSoftwareRenderer(''), false);
});

test('no warning when the page never asked for WebGL', () => {
    assert.equal(webglWarning({renderer: HEADLESS, software: true, requested: [], blind: false}), null);
});

test('no warning when the browser had a real GPU', () => {
    const webgl = {renderer: 'Apple M1 Pro', software: false, requested: ['webgl2'], blind: false};
    assert.equal(webglWarning(webgl), null);
});

test('a warning names what was asked for and says the region is unmeasured, not empty', () => {
    const w = webglWarning({renderer: HEADLESS, software: true, requested: ['webgl2'], blind: true});
    assert.match(w, /webgl2/);
    assert.match(w, /SwiftShader/);
    assert.match(w, /unmeasured, not empty/);
});

test('a missing or absent webgl block never throws', () => {
    assert.equal(webglWarning(undefined), null);
    assert.equal(webglWarning(null), null);
    assert.equal(webglWarning({}), null);
});
