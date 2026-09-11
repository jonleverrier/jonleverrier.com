// Interactive dot grid for .c-jonson (and, via options, .c-content).
//
// The ambient grid is normally painted in CSS (.c-jonson::before/::after — a
// faint base plus a diagonal brightening sweep). When JS is available and the
// visitor isn't reduced-motion, this module takes the grid over on a canvas so
// the dots can react to the pointer: near the cursor they gather toward it (an
// attract / lens warp), brighten and swell, then ease back when it moves on.
//
// It reproduces the CSS look exactly — same 26px cells, same light-700 dots,
// same faint base and travelling sweep — so nothing is lost, only made live.
// The CSS pseudo-grid stays as the no-JS / reduced-motion / touch fallback
// (hidden via `.is-interactive` only once the canvas is actually up).
//
// Cost is bounded by the VIEWPORT, not the container. The grid lives in
// container coordinates (so the sweep crosses the whole box, however tall), but
// the bitmap is only ever container-width × viewport-height: each frame it is
// translated down to the on-screen slice and only the rows inside that slice are
// drawn. A 14,000px article costs the same as a 1,000px one.
//
// The loop runs only while the section is near the screen AND the tab is
// focused (IntersectionObserver + visibilitychange); otherwise it's stopped.

const SPACING = 26;                 // match background-size in _jonson.scss
const DOT_RGB = '241, 234, 218';    // light-700 (#f1eada)
const DOT_RADIUS = 1.1;             // match the radial-gradient dot
const NEAR_RADIUS = 0.9;            // px added under the cursor (per-surface, see options)
const BASE_ALPHA = 0.10;            // match .c-jonson::before
const SWEEP_ALPHA = 0.3;           // extra brightness inside the sweep band (≈ ::after)
const SWEEP_PERIOD = 16000;         // ms — match the 16s CSS sweep
const SWEEP_DEG = 115;              // match linear-gradient(115deg …)

const WARP_RADIUS = 260;            // px around the cursor that dots respond within
const WARP_PULL = 0.1;              // peak fraction of the way toward the cursor (attract)
const EASE = 0.12;                  // per-frame glide toward the target displacement
const REST = 0.05;                  // px below which a dot counts as settled

const PULSE_MS = 2000;              // one-shot celebratory sweep duration (slow travel across)
const PULSE_BAND = 0.3;             // width of the swelling band (fraction of the diagonal)
// The sweep swells + brightens each dot by the SAME amount the pointer-hover does
// (see the `near` terms in draw), so a swept dot looks identical to a hovered one —
// not a bigger, darker blob. Bump these together if you want it more pronounced.
const PULSE_DR = 1.4;               // px radius added at the band's peak (peak dot ≈ 2.5px)
const NEAR_ALPHA = 0.35;            // alpha added under the cursor (per-surface, see options)
const PULSE_DA = NEAR_ALPHA;        // alpha added at the band's peak — matches the hover lift

// Resting dots (constant radius, alpha varying only with the sweep) are batched:
// alpha is quantised into this many steps and every dot in a step goes into one
// Path2D, filled once. 128 steps = 0.008 alpha per step, well under anything the
// eye can pick out on a soft 20%-of-the-diagonal gradient.
const ALPHA_STEPS = 128;
const HAS_PATH2D = typeof Path2D === 'function';

// Cells the pointer can reach, in grid units, either side of the cursor cell.
const WARP_CELLS = Math.ceil(WARP_RADIUS / SPACING) + 1;

const smoothstep = (f) => f * f * (3 - 2 * f);
const noop = () => {};

// options lets a second surface (e.g. .c-content on the cream slab) reuse the
// warp with its own dot colour/brightness; defaults reproduce the .c-jonson look.
export function mountGrid(container, options = {}) {
    if (!container) return noop;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return noop; // leave the CSS grid untouched
    }
    // The only thing the canvas adds over the CSS grid is the pointer warp. With
    // no hover-capable fine pointer there is nothing to see, so don't pay for a
    // canvas, a rAF loop and pointer listeners — the CSS grid stays.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        return noop;
    }

    const dotRgb = options.dotRgb ?? DOT_RGB;
    const baseAlpha = options.baseAlpha ?? BASE_ALPHA;
    const sweepAlpha = options.sweepAlpha ?? SWEEP_ALPHA;
    // How much darker a dot goes under the cursor. Separate from the size lift, so a
    // surface can keep the swell and soften the darkening — which is what the cream
    // slab wants: the same darkening that reads as a subtle glow on olive reads as a
    // smudge against a light background.
    const nearAlpha = options.nearAlpha ?? NEAR_ALPHA;
    // Dot size, resting and under the cursor. The alpha levers run out on a light
    // surface — a white dot at 1 has nowhere left to go — so size is the only way
    // left to make the grid read stronger, or its hover land harder, once the
    // colour is close to opaque.
    const dotRadius = options.dotRadius ?? DOT_RADIUS;
    const nearRadius = options.nearRadius ?? NEAR_RADIUS;
    const fillRgb = `rgb(${dotRgb})`;

    const canvas = document.createElement('canvas');
    canvas.className = 'c-jonson__grid';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '0',             // set in px by build(): the on-screen slice, not the box
        zIndex: '-1',            // behind content, alongside the pseudo-grid
        pointerEvents: 'none',   // never intercept clicks; we track the pointer on window
    });
    const ctx = canvas.getContext('2d');
    if (!ctx) return noop;
    container.appendChild(canvas);

    // Container box (CSS px) and the grid over it. The grid is indexed by absolute
    // (i, j) across the WHOLE box so warp state survives scrolling.
    let w = 0, h = 0, cols = 0, rows = 0;
    let ox = new Float32Array(0); // current x displacement per dot
    let oy = new Float32Array(0); // current y displacement per dot
    // The bitmap: container-width × min(container-height, viewport-height), placed
    // at `offY` px down the container so it covers the on-screen slice.
    let ch = 0, vh = 0, offY = -1, dpr = 1;
    // Container rect from the last frame (viewport coords), for the pointer.
    let rectTop = 0, rectLeft = 0;
    // Sweep projection axis (115°) + its range across the box, for the band.
    const dirX = Math.cos((SWEEP_DEG * Math.PI) / 180);
    const dirY = Math.sin((SWEEP_DEG * Math.PI) / 180);
    let projMin = 0, projSpan = 1;

    const build = (rect) => {
        w = Math.max(1, Math.round(rect.width));
        h = Math.max(1, Math.round(rect.height));
        vh = window.innerHeight;
        ch = Math.min(h, vh);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.height = `${ch}px`;
        offY = -1; // force the transform to be rewritten

        cols = Math.ceil(w / SPACING) + 1;
        rows = Math.ceil(h / SPACING) + 1;
        ox = new Float32Array(cols * rows);
        oy = new Float32Array(cols * rows);

        // The sweep spans the whole box, not the slice — that's what makes the
        // bitmap a window onto the grid rather than a crop of it.
        const projs = [0, 0, 0, 0].map((_, k) =>
            (k & 1 ? w : 0) * dirX + (k & 2 ? h : 0) * dirY);
        projMin = Math.min(...projs);
        projSpan = Math.max(...projs) - projMin || 1;
    };

    // Slide the bitmap to the on-screen slice of the container. Clamped so it
    // never overhangs the bottom of the box. One style write on a composited
    // element; no layout.
    const place = (rect) => {
        const next = Math.max(0, Math.min(h - ch, Math.round(-rect.top)));
        if (next !== offY) {
            offY = next;
            canvas.style.transform = `translate3d(0, ${offY}px, 0)`;
        }
    };

    // Timestamp of the last celebratory pulse (see dispose.pulse); -Infinity = none.
    let pulseT0 = -Infinity;

    // Pointer position in container coords, or null when it's outside the grid.
    // Uses the rect the loop read this frame — no layout read per pointermove.
    let px = null, py = null;
    const onMove = (e) => {
        const x = e.clientX - rectLeft;
        const y = e.clientY - rectTop;
        px = (x >= 0 && x <= w && y >= 0 && y <= h) ? x : null;
        py = px === null ? null : y;
    };
    const onLeave = () => { px = null; py = null; };

    const drawDot = (x, y, r, alpha) => {
        ctx.beginPath();
        ctx.globalAlpha = alpha;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    };

    const draw = (t) => {
        const phase = (t % SWEEP_PERIOD) / SWEEP_PERIOD;   // 0..1 sweep progress
        const band = projSpan * 0.2;                       // half-width of the bright band
        const centre = projMin + projSpan * (1.2 - 1.4 * phase); // travels across, both ends off

        // Every piece of context state this frame depends on is set HERE, every
        // frame — nothing is trusted to survive from build(). A browser can drop a
        // canvas's backing store while its window sits in the background (Safari
        // does, under memory pressure) and hand back a context with its state at
        // the defaults: identity transform, black fill. Set once at build, that
        // showed up as black dots at half pitch in the top-left quarter of the box
        // after the window had been left open a while. The calls are trivially
        // cheap; the alternative is a grid that depends on never being purged.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, w, ch);
        ctx.fillStyle = fillRgb;

        // One-shot celebratory SWEEP: a band of swell travels across the grid
        // (top-left → bottom-right). `front` is the wave position over the diagonal;
        // each dot swells (per-dot, below) as the band passes it, then eases back.
        const pulseAge = t - pulseT0;
        const pulsing = pulseAge >= 0 && pulseAge < PULSE_MS;
        const front = pulsing ? (pulseAge / PULSE_MS) * (1 + PULSE_BAND) : -1;

        // Only the rows inside the slice, plus one either side for dots that are
        // displaced across the edge.
        const j0 = Math.max(0, Math.floor(offY / SPACING) - 1);
        const j1 = Math.min(rows, Math.ceil((offY + ch) / SPACING) + 1);

        // Cells the cursor can reach — the hypot test is skipped everywhere else.
        let pi = -1, pj = -1;
        if (px !== null) {
            pi = Math.floor(px / SPACING);
            pj = Math.floor(py / SPACING);
        }

        // Resting dots batched by quantised alpha (see ALPHA_STEPS).
        const paths = HAS_PATH2D ? [] : null;

        for (let j = j0; j < j1; j++) {
            // Offset by half a cell so the dots land on the CSS grid's cell
            // centres (its radial-gradient sits at background-size / 2), not the
            // corners — otherwise every dot jumps half a cell when the canvas
            // takes over from the CSS ::before on load.
            const by = j * SPACING + SPACING / 2;
            const cy = by - offY;   // y on the bitmap
            const rowNear = pj >= 0 && Math.abs(j - pj) <= WARP_CELLS;

            for (let i = 0; i < cols; i++) {
                const idx = j * cols + i;
                const bx = i * SPACING + SPACING / 2;

                // Attract: target a displacement toward the cursor, fading out
                // with distance; then ease the live offset toward that target.
                let tx = 0, ty = 0, near = 0;
                if (rowNear && Math.abs(i - pi) <= WARP_CELLS) {
                    const dx = px - bx;
                    const dy = py - by;
                    const dist = Math.hypot(dx, dy);
                    if (dist < WARP_RADIUS) {
                        near = smoothstep(1 - dist / WARP_RADIUS);
                        tx = dx * WARP_PULL * near;
                        ty = dy * WARP_PULL * near;
                    }
                }
                ox[idx] += (tx - ox[idx]) * EASE;
                oy[idx] += (ty - oy[idx]) * EASE;

                // Brightness: faint base + travelling sweep + a lift near the cursor.
                const proj = bx * dirX + by * dirY;
                const inBand = Math.max(0, 1 - Math.abs(proj - centre) / band);
                // Sweep swell for this dot: how close the travelling band's front is
                // to the dot's position along the top-left→bottom-right diagonal.
                let grow = 0;
                if (pulsing) {
                    const projN = (bx + by) / (w + h);   // 0 (top-left) … 1 (bottom-right)
                    const d = front - projN;
                    if (d >= 0 && d <= PULSE_BAND) grow = Math.sin((d / PULSE_BAND) * Math.PI);
                }

                const alpha = baseAlpha + sweepAlpha * smoothstep(inBand) + nearAlpha * near + PULSE_DA * grow;
                const x = bx + ox[idx];
                const y = cy + oy[idx];

                if (paths === null || near > 0 || grow > 0) {
                    // Radius varies: draw it on its own.
                    drawDot(x, y, dotRadius + nearRadius * near + PULSE_DR * grow, alpha);
                } else {
                    const step = Math.min(ALPHA_STEPS, Math.round(alpha * ALPHA_STEPS));
                    let path = paths[step];
                    if (path === undefined) { path = paths[step] = new Path2D(); }
                    path.moveTo(x + dotRadius, y);
                    path.arc(x, y, dotRadius, 0, Math.PI * 2);
                }
            }
        }

        if (paths !== null) {
            for (let s = 0; s < paths.length; s++) {
                const path = paths[s];
                if (path === undefined) continue;
                ctx.globalAlpha = s / ALPHA_STEPS;
                ctx.fill(path);
            }
        }
        ctx.globalAlpha = 1;
    };

    // ── Run only while visible + focused ────────────────────────────────────
    let raf = null;
    let onScreen = true;
    let focused = !document.hidden;
    let lastT = 0; // last frame's timestamp, so an off-loop redraw keeps the sweep
    let built = false;

    // One layout read per frame: it positions the slice (scroll moves the
    // container's top) and catches the box changing size — e.g. the height
    // growing during the reveal animation — before ResizeObserver reports it.
    // Without that the fixed-size bitmap is CSS-stretched to the growing box and
    // the dots visibly drift until a rebuild lands. getBoundingClientRect is cheap
    // when layout is clean (idle), and layout is dirty during the animation anyway.
    const measure = () => {
        const rect = container.getBoundingClientRect();
        rectTop = rect.top;
        rectLeft = rect.left;
        if (Math.max(1, Math.round(rect.width)) !== w ||
            Math.max(1, Math.round(rect.height)) !== h ||
            window.innerHeight !== vh) {
            build(rect);
        }
        place(rect);
    };

    const loop = (t) => { lastT = t; measure(); draw(t); raf = requestAnimationFrame(loop); };
    const running = () => raf !== null;
    const start = () => { if (built && !running() && onScreen && focused) raf = requestAnimationFrame(loop); };
    const stop = () => { if (running()) { cancelAnimationFrame(raf); raf = null; } };
    const sync = () => (onScreen && focused ? start() : stop());

    // Re-measure + resize the bitmap when the container's box changes. Done
    // SYNCHRONOUSLY in the ResizeObserver callback (which fires after layout,
    // before paint), not deferred to the next frame: otherwise, while the content
    // animates its height, the bitmap is CSS-scaled to the growing box for a frame
    // before the rebuild lands — so the dots visibly drift/stretch, then snap.
    // Resizing the (absolute) canvas doesn't change the observed element's box, so
    // this can't loop. Redraw at once since resizing clears the bitmap.
    //
    // The FIRST notification is also the first build: it arrives after the page's
    // own first layout, so measuring here doesn't force one from script. The
    // canvas paints a frame BEFORE the CSS dots are hidden, so there's never a
    // frame where ::before is already gone but the canvas hasn't drawn yet — that
    // gap is what read as a blink/flash on load. (.c-jonson is `hidden` at load,
    // so for it this fires on first reveal.)
    const rebuild = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        rectTop = rect.top;
        rectLeft = rect.left;
        build(rect);
        place(rect);
        draw(lastT);
        if (!built) {
            built = true;
            container.classList.add('is-interactive'); // CSS now hides ::before
            start();
        }
    };

    // Wake a viewport early so the grid is already moving as it scrolls in.
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); },
        { rootMargin: '50% 0px' });
    io.observe(container);
    // Coming back to the tab reallocates the bitmap rather than just resuming:
    // whatever the browser did to the buffer while the page was hidden — purged
    // it, restored it from stale memory — a fresh allocation is clean. Same on a
    // back/forward-cache restore, and on the context being restored after a loss,
    // where the browser has explicitly told us the buffer is gone.
    const onVisibility = () => {
        focused = !document.hidden;
        if (focused && built) rebuild();
        sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onPageShow = () => { if (built) rebuild(); };
    window.addEventListener('pageshow', onPageShow);
    const onContextRestored = () => { if (built) rebuild(); };
    canvas.addEventListener('contextrestored', onContextRestored);

    // Tracks width (viewport) AND height (content growth).
    const ro = new ResizeObserver(rebuild);
    ro.observe(container);

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave, { passive: true });

    const dispose = function dispose() {
        stop();
        io.disconnect();
        ro.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pageshow', onPageShow);
        canvas.removeEventListener('contextrestored', onContextRestored);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerleave', onLeave);
        container.classList.remove('is-interactive');
        canvas.remove();
    };

    // Fire a one-shot celebratory pulse — all dots swell to ~2× then ease back.
    // Used as a beat when the contact form submits successfully. start() covers the
    // case where the loop was idle (it only runs while on-screen + focused anyway).
    dispose.pulse = () => { pulseT0 = performance.now(); start(); };

    return dispose;
}
