/**
 * THINKING ORB
 *
 * The wait between a question and its first token, drawn as colour moving inside a
 * glass sphere.
 *
 * WHAT IT IS. Five soft blobs in the site's own palette drift and wobble on a canvas,
 * composited with `screen` so where they overlap they brighten rather than cover.
 * The canvas is blurred and masked to the middle of the ball, so the colour reads as
 * something suspended INSIDE glass with clear thickness at the rim, rather than as a
 * pattern printed on a disc. Everything around it — the refracted band bending round
 * the edge, the rim shading, the specular, the halo and the contact shadow — is CSS,
 * in _jonson.scss.
 *
 * WHY THIS REPLACED A PARTICLE SPHERE. The version before this projected 420 points in
 * 3D so that the far side was smaller, dimmer and travelling the other way. It read as
 * a sphere, which was the whole point of it, and it read as a MACHINE — a lattice, a
 * scan, something counting. The wait it fills is a person thinking, and this one moves
 * like weather instead: slow, unrepeating, with no structure to lock onto.
 *
 * THE LIGHT IS BEHIND YOUR EYES. The specular sits dead centre rather than up and to
 * the left, so the sphere looks lit from where the reader is rather than from a lamp
 * off to one side. That is also why the shadow is an even rim all the way round rather
 * than a pool underneath: the light is frontal, so the shadow falls straight back.
 *
 * THE LOOP STOPS ITSELF. The thread replaces the thinking node with the answer the
 * moment the first token lands (see jonson-ask.js), so rather than plumbing a teardown
 * through the stream, each frame asks whether the canvas is still in the document and
 * gives up when it isn't. A thinking indicator that outlived its answer and kept a rAF
 * loop running would be invisible and permanent.
 */

// THE PALETTE, AND THE ONE DELIBERATE DEPARTURE FROM IT. Four of these are the tokens
// in theme/_setup.scss. The first is primary-450 as it was BEFORE that token was
// darkened to #3a6479 — a change made so 12px whisper labels could clear AA on cream.
// Nothing here is text, the orb is aria-hidden, and the darker blue disappears against
// the sphere's own near-navy fill; the lighter one is what makes the body of the ball
// read as lit. Same hue, and it is the only value in this file that is not a token.
const BLOBS = [
    {rgb: [78, 136, 164],  r: 0.44, orbit: 1.0, fx: 0.71, fy: 0.53, phase: 0.0},   // primary-450, pre-darkening
    {rgb: [182, 221, 255], r: 0.30, orbit: 0.9, fx: 0.47, fy: 0.83, phase: 1.7},   // primary-430 #b6ddff
    {rgb: [255, 185, 41],  r: 0.40, orbit: 1.1, fx: 0.93, fy: 0.61, phase: 3.1},   // primary-400 #ffb929
    {rgb: [224, 46, 26],   r: 0.36, orbit: 1.2, fx: 0.59, fy: 1.07, phase: 4.4},   // primary-600 #e02e1a
    {rgb: [232, 245, 255], r: 0.14, orbit: 1.3, fx: 1.13, fy: 0.77, phase: 5.6},   // primary-410 #e8f5ff
];

// css px. The backing store is this times the device ratio; the CSS box is `$orb` in
// _jonson.scss, where the halo, the shadow and the blurs are all derived from it.
// THE TWO NUMBERS MUST AGREE — it is the one pair the SCSS variable cannot bind.
const SIZE = 75;

// How the orb behaves while it waits. There is only one state: the node is destroyed
// the instant the answer arrives, so "speaking" and "idle" have nowhere to live here.
const SPEED = 0.95;   // how fast the blobs travel
const AMP = 0.15;     // how far each blob's outline wobbles from a circle
const ORBIT = 0.26;   // how far from centre they wander, as a fraction of the box
const ENERGY = 0.75;  // drives the halo and the refracted band, through --energy
const PULSE = 0.022;  // how much the whole ball breathes

const STEPS = 72;     // points around one blob's outline — smooth at this size, cheap

/** Colour moving inside glass. Returns a teardown, though nothing needs to call it. */
export function mountThinkingOrb(canvas) {
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) {
        return () => {};
    }

    // The element the custom properties are written to: the sphere, which is also what
    // the CSS layers hang off. Falls back to the canvas so a lone canvas still animates.
    const host = canvas.closest('.c-jonson__orb') ?? canvas;

    // Cap at 2. Beyond that the backing store grows four-fold for a blurred image a
    // hundred pixels across, which nobody can see and every frame has to paint.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(SIZE * dpr);
    canvas.width = w;
    canvas.height = w;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const centre = w / 2;

    let raf = 0;
    let stopped = false;
    let last = performance.now();
    let t = 0;      // blob travel, in its own time so speed can vary without a jump
    let spin = 0;   // whole-canvas rotation, and the angle of the refracted band
    let clock = 0;  // wall time, for the breath

    const blob = (b, cx, cy, radius, time) => {
        ctx.beginPath();
        for (let i = 0; i <= STEPS; i++) {
            const a = (i / STEPS) * Math.PI * 2;
            // Three waves at different rates: one alone is a lobed circle that reads as
            // a flower, and the beat between three never quite repeats.
            const wobble = Math.sin(a * 3 + time * 1.3 + b.phase) * 0.55
                + Math.sin(a * 5 - time * 0.9 + b.phase * 1.7) * 0.30
                + Math.sin(a * 2 + time * 0.5 + b.phase * 0.6) * 0.15;
            const rr = radius * (1 + AMP * wobble);
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();

        const [r, g, bl] = b.rgb;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.15);
        grad.addColorStop(0, `rgba(${r},${g},${bl},0.95)`);
        grad.addColorStop(0.55, `rgba(${r},${g},${bl},0.7)`);
        grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        ctx.fillStyle = grad;
        ctx.fill();
    };

    const draw = (now) => {
        // STOP WHEN THE NODE GOES. commit() in jonson-ask.js empties this answer node
        // the moment the first token lands, which is the only way the orb ever ends.
        if (stopped || !canvas.isConnected) {
            stopped = true;
            return;
        }

        const dt = Math.min(0.05, (now - last) / 1000); // a tab that slept must not jump
        last = now;
        clock += dt;

        // Reduced motion still paints — a frozen ball with a hard edge looks broken —
        // but slowly enough that nothing sweeps or flickers.
        const motion = reduced ? 0.3 : 1;
        t += dt * SPEED * motion;
        spin += dt * SPEED * 0.35 * motion;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, w);
        ctx.translate(centre, centre);
        ctx.rotate(spin);
        ctx.translate(-centre, -centre);

        // SCREEN, NOT SOURCE-OVER. Overlapping blobs have to brighten where they cross,
        // the way light through two filters does; painted normally the last one drawn
        // simply hides the others and the ball reads as cut paper.
        ctx.globalCompositeOperation = 'screen';
        const orbit = w * ORBIT;
        for (const b of BLOBS) {
            const cx = centre + Math.cos(t * b.fx * 2 + b.phase) * orbit * b.orbit;
            const cy = centre + Math.sin(t * b.fy * 2 + b.phase * 1.3) * orbit * b.orbit;
            blob(b, cx, cy, w * 0.5 * b.r, t * 2);
        }

        // A faint core, so the middle of the ball stays the brightest part of it however
        // the blobs happen to be arranged.
        ctx.globalCompositeOperation = 'lighter';
        const core = ctx.createRadialGradient(centre, centre, 0, centre, centre, w * 0.28);
        core.addColorStop(0, `rgba(255,255,255,${(0.08 + ENERGY * 0.12).toFixed(3)})`);
        core.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, w, w);

        // Three numbers the CSS layers read. Written every frame, which is cheap — they
        // are custom properties on one element, not a style recalculation of a tree.
        const breath = 1 + PULSE * Math.sin(clock * 2.6) * motion;
        host.style.setProperty('--orb-pulse', breath.toFixed(4));
        host.style.setProperty('--orb-spin', `${((spin * 180 / Math.PI) % 360).toFixed(2)}deg`);
        host.style.setProperty('--orb-energy', ENERGY.toFixed(3));

        raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
        stopped = true;
        cancelAnimationFrame(raf);
    };
}
