/**
 * THINKING ORB
 *
 * The wait between a question and its first token, drawn as a sphere of particles
 * turning in three dimensions.
 *
 * WHY CANVAS AND NOT CSS. This began as CSS — a lattice of box-shadow dots, then a
 * disc of the page's own dot field, then that disc with a rim, a specular and gradient
 * arcs turning inside it. Each step looked more like a ball and none of them WAS one:
 * every version was a flat circle with shading painted on, and the give-away is that
 * nothing ever passed behind anything else. A sphere reads as a sphere because points
 * on the far side are smaller, dimmer and moving the other way, and no amount of
 * radial-gradient gets you that. So the points are real: positions in 3D, rotated and
 * projected every frame.
 *
 * It is a close cousin of what the site already does. jonson-grid.js fills a canvas
 * with cream dots on a 26px lattice and lifts them under the cursor; the hero is a
 * point cloud. This is the same material — the same cream, the same idea that a lit
 * dot gains BOTH radius and alpha — arranged on a sphere instead of a plane.
 *
 * NO LIBRARY. Four hundred points, one rotation, one projection: three.js would be
 * ~150KB to do arithmetic that fits in this file.
 *
 * The loop stops itself. The thread replaces the thinking node with the answer the
 * moment the first token lands (see jonson-ask.js), so rather than plumbing a teardown
 * through the stream, each frame asks whether the canvas is still in the document and
 * gives up when it isn't. A thinking indicator that outlived its answer and kept a
 * rAF loop running would be invisible and permanent.
 */

// THREE COLOURS, ALL ALREADY IN THE THEME. One cream sphere read as washed out: every
// point the same hue meant depth could only be carried by alpha, and alpha alone is
// haze rather than distance.
//
//   NEAR  light-700  #f1eada — the cream the dot field is drawn in (DOT_RGB in
//                    jonson-grid.js), so the front of the ball is the page's own material
//   FAR   primary-430 #b6ddff — the same pale blue as the halo behind it. Distant things
//                    going cool and blue is what atmosphere does, and borrowing the
//                    halo's own hue means the back of the sphere dissolves into its glow
//                    rather than into a different colour
//   HOT   primary-430 #b6ddff — the site's light blue, the one the Jonson titles and the
//                    footer strapline are set in, carried only by the travelling band.
//
// The band was amber (primary-400) for a moment and it worked optically — warm light
// on a cool body is the sharpest possible read — but it was the one colour here that
// belongs to nothing else on the page. The light blue is the site's own accent, so the
// band now lights the sphere in a colour the rest of the design already speaks.
//
// Which means the FAR colour had to move: with the band and the far side both on 430
// there was nothing between them and the depth went flat. It is now the deeper blue
// (primary-450), so the sphere recedes into teal and the band arrives as the pale
// version of that same hue — one colour family, lit and unlit, rather than two.
const C_NEAR = [241, 234, 218];
const C_FAR = [58, 100, 121];
const C_HOT = [182, 221, 255];

const COUNT = 420;      // enough that the shell reads as a surface, not as scattered dots
const SIZE = 124;       // css px — matches the halo behind it in _jonson.scss
const R = 0.86;         // sphere radius as a fraction of the half-box, leaving room for
                        //   the perspective bulge at the near pole

// Perspective divisor. Small numbers exaggerate depth (a fish-eye ball); large ones
// flatten it to an orthographic disc, which is exactly the look we are climbing out
// of. 2.6 is enough that the near face clearly stands proud.
const PERSP = 2.6;

const SPIN = 0.46;      // radians/sec about Y — the main turn
const TUMBLE = 0.11;    // radians/sec about X — a second, slower axis, so the poles
                        //   drift and the thing never looks like a spinning label
const TILT = 0.38;      // radians of resting lean, so we never look straight down a pole

const BREATHE_MS = 2400; // matches the halo's breathing in the stylesheet
// Sweeps of the brightening plane per second. 0.55 (one pass every 1.8s) read as a
// wipe hurrying across; 0.3 took about three and a third seconds, which was long
// enough to watch it travel rather than catch it having travelled. 0.24 is a little
// slower again — 4.2s — now that the sphere it crosses is smaller and the plane has
// less distance to cover, so the same rate read faster than it did.
//
// Not 0.25, which would be a tidy 4.0s against the 2.4s breathe: a 5:3 ratio puts the
// two back in phase every 12s, and a backdrop that visibly repeats is a backdrop you
// start watching. 0.24 pushes that out to ~25s.
const SCAN_HZ = 0.24;

/**
 * Points spread evenly over a unit sphere by the Fibonacci spiral.
 *
 * Not random: random points clump, and the clumps read as texture rather than as a
 * surface. Not lat/long either, which crowds the poles and makes the ball look like a
 * wireframe globe. The golden angle lands each point in the largest remaining gap, so
 * the shell is even everywhere and has no seam to notice as it turns.
 */
const sphere = (n) => {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;      // +1 down to -1
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        pts[i * 3] = Math.cos(theta) * r;
        pts[i * 3 + 1] = y;
        pts[i * 3 + 2] = Math.sin(theta) * r;
    }

    return pts;
};

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void} teardown (also self-stops once the canvas leaves the document)
 */
export function mountThinkingOrb(canvas) {
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return () => {};

    // Cap at 2. Beyond that the backing store grows four-fold for dots a couple of
    // pixels across, which nobody can see and every frame has to paint.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);

    const pts = sphere(COUNT);
    const half = (SIZE * dpr) / 2;
    const radius = half * R;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reused across frames so the per-point work allocates nothing.
    const order = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) order[i] = {x: 0, y: 0, z: 0, s: 0, a: 0, r: 0, g: 0, b: 0};

    let raf = 0;
    let stopped = false;
    const started = performance.now();

    const draw = (now) => {
        const t = (now - started) / 1000;
        const ay = reduced ? 0.7 : SPIN * t;
        const ax = TILT + (reduced ? 0 : Math.sin(t * TUMBLE) * 0.5);

        const cosY = Math.cos(ay);
        const sinY = Math.sin(ay);
        const cosX = Math.cos(ax);
        const sinX = Math.sin(ax);

        // THE SPHERE BREATHES FROM 64% TO 80% OF ITS RADIUS AND BACK.
        //
        // It was 4% either side of full — technically a pulse, and invisible; 4% of a
        // 124px sphere is about two pixels. A fifth of the radius moves the whole
        // shape, which is what makes it read as waiting rather than as a still picture
        // with something twitching inside it. That fifth is kept here: 0.64 to 0.80 is
        // the same 1.25x swell the 0.80-to-1.00 version had, moved down the scale.
        //
        // The CEILING is the part that changed — it used to reach 1.0, filling the box
        // it is drawn into. At ~107px against a 124px canvas the sphere was the whole
        // component, and the halo behind it had nothing to be a halo AROUND. Topping
        // out at 0.80 (~85px) leaves the glow somewhere to sit.
        //
        // -cos rather than sin, so the cycle STARTS at the small end and grows: the orb
        // appears the instant the question is sent, so the first frame is the one
        // everybody actually sees, and it should be gathering itself rather than caught
        // mid-deflate. 0.80 is now the ceiling, never more — overshooting would push
        // points out through the halo.
        //
        // Reduced motion holds it at the CEILING, not at 1.0 — a still sphere should be
        // the same size as the moving one at its fullest, and 1.0 stopped being that.
        const breathe = reduced ? 0.8 : 0.72 - Math.cos((t * 1000 / BREATHE_MS) * Math.PI * 2) * 0.08;

        // A plane of brightness travelling through the ball along x. Points it passes
        // gain radius AND alpha together — the same pairing the canvas grid applies
        // under the cursor, so a lit point here and a hovered dot on the page read as
        // the same kind of event.
        const wave = reduced ? 0 : Math.sin(t * Math.PI * 2 * SCAN_HZ);

        for (let i = 0; i < COUNT; i++) {
            const px = pts[i * 3];
            const py = pts[i * 3 + 1];
            const pz = pts[i * 3 + 2];

            // Y then X. Order matters: the other way round the tumble would swing the
            // whole ball rather than lean it.
            const x1 = px * cosY + pz * sinY;
            const z1 = pz * cosY - px * sinY;
            const y2 = py * cosX - z1 * sinX;
            const z2 = z1 * cosX + py * sinX;

            const scale = PERSP / (PERSP - z2);         // nearer → larger
            const depth = (z2 + 1) / 2;                  // 0 at the back, 1 at the front

            const near = 1 - Math.min(1, Math.abs(x1 - wave) / 0.38);
            const lit = near * near;                     // squared, so the band has an edge

            const o = order[i];
            o.x = half + x1 * radius * breathe * scale;
            o.y = half + y2 * radius * breathe * scale;
            o.z = z2;
            // Back points stay visible but faint — a sphere you can see through is the
            // difference between a ball of points and a disc of them.
            // The lit lift is bigger than it was for the amber band: a pale blue among
            // cream points has far less hue contrast to spend, so it has to win on
            // brightness instead.
            o.a = (0.12 + 0.70 * depth * depth) + lit * 0.50;
            // Radius: a floor so the far side stays visible, plus a depth term so the
            // near face is plainly bigger, times the perspective scale. The 0.66 is the
            // overall gauge — it was 0.5, which drew the sphere honestly but read as
            // grit at this size rather than as points you can see.
            o.s = (0.8 + 1.6 * depth) * scale * dpr * 0.66 + lit * 1.1 * dpr;

            // Colour carries depth as well as alpha: cool and blue at the back, cream
            // at the front. Then the band warms whatever it is crossing — capped below
            // full amber so the points read as heated rather than repainted.
            const w = lit * 0.88;
            o.r = (C_FAR[0] + (C_NEAR[0] - C_FAR[0]) * depth) * (1 - w) + C_HOT[0] * w;
            o.g = (C_FAR[1] + (C_NEAR[1] - C_FAR[1]) * depth) * (1 - w) + C_HOT[1] * w;
            o.b = (C_FAR[2] + (C_NEAR[2] - C_FAR[2]) * depth) * (1 - w) + C_HOT[2] * w;
        }

        // Painter's algorithm: far points first, so the near face genuinely covers the
        // far one where they overlap.
        order.sort((a, b) => a.z - b.z);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < COUNT; i++) {
            const o = order[i];
            ctx.beginPath();
            ctx.arc(o.x, o.y, Math.max(0.35, o.s), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${o.r | 0}, ${o.g | 0}, ${o.b | 0}, ${o.a.toFixed(3)})`;
            ctx.fill();
        }

        if (reduced || stopped) return;                  // one frame is the whole show
        if (!canvas.isConnected) { stopped = true; return; } // the answer replaced us
        raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
        stopped = true;
        cancelAnimationFrame(raf);
    };
}
