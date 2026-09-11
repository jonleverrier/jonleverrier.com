/**
 * TUNNEL
 *
 * WebGL "infinite tunnel" of image planes drifting towards the camera.
 *
**/

import * as THREE from 'three';

// Constants are floema's verbatim — see FLOATING_IMAGES_SPEC.md.
// FOG_COLOR MUST equal the page background colour or planes will pop in.
const CONFIG = {
    SPEED_START: 300,        // z-units/sec at page load
    SPEED_IDLE: 10,          // z-units/sec cruising speed
    SLOWDOWN_DURATION: 1.1,  // seconds from start speed to idle
    SPACING: 1.2,            // z-gap between consecutive planes
    IMAGE_SIZE: 1.5,         // base plane size in world units
    SCALE_RANDOMNESS: 0.5,   // + up to this much, randomly per plane
    RADIUS: 10,              // ring radius; keeps the centre clear for the headline
    FOG_NEAR: 0,
    FOG_FAR: 78,             // tunnel depth; planes spawn here
    FOG_COLOR: 0x4a5030,
};

// Phyllotaxis distribution — scatters planes evenly with no visible pattern
// and guarantees the centre of the screen stays empty.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Placeholder images. Swap for transparent cutouts to make the drift feel airier.
// Thumbnails are a fixed landscape size; aspect is derived from these requested
// dimensions (THUMB_ASPECT below), NOT the decoded image, because picsum can
// occasionally return EXIF-rotated/cached frames whose width/height come back
// portrait — which flipped planes to portrait on back-navigation. When swapping
// in real, variably-shaped art, derive aspect per-image from tex.image instead.
const THUMB_W = 464;
const THUMB_H = 312;
const THUMB_ASPECT = THUMB_W / THUMB_H;
const IMAGE_URLS = Array.from({length: 10}, (_, i) =>
    `https://picsum.photos/seed/tunnel-${i}/${THUMB_W}/${THUMB_H}`
);

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -6 * t));
const easeInExpo = (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1)));

// Exit "warp": ramp the drift up hard and fade the canvas as we punch through.
const WARP_SPEED = 520;     // peak z-units/sec
const WARP_DURATION = 0.75; // seconds

// Plane i sits at (cos(i·GOLDEN)·r, sin(i·GOLDEN)·r). x and y never change
// after spawn — only z animates.
const lane = (radius, i) => {
    const a = i * GOLDEN_ANGLE;
    return {x: Math.cos(a) * radius, y: Math.sin(a) * radius};
};

export function mountTunnel(hero) {
    // Hard requirement from the spec — never mount for reduced-motion users.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return {dispose: () => {}, warpOut: (cb) => { if (cb) cb(); }};
    }

    const canvas = hero.querySelector('[data-tunnel-canvas]');
    if (!canvas) return {dispose: () => {}, warpOut: (cb) => { if (cb) cb(); }};

    // alpha:true lets the page background show through; antialias:false because
    // fog + soft fade means we don't need edge AA. DPR capped at 2 per spec.
    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    // Fog IS the fade-in. Planes spawning at z = -FOG_FAR are invisible and
    // materialise gradually as they approach. Do not animate opacity.
    scene.fog = new THREE.Fog(CONFIG.FOG_COLOR, CONFIG.FOG_NEAR, CONFIG.FOG_FAR);

    // Aspect is set in resize() once the hero has dimensions.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.z = 5;

    // Derived count: enough planes to keep the tunnel full from back to camera,
    // plus a small buffer so recycled planes never pop in visibly.
    const planeCount =
        Math.ceil((CONFIG.FOG_FAR + camera.position.z + CONFIG.SPACING * 2) / CONFIG.SPACING) + 2;

    // One shared geometry — every plane is a unit quad, scaled per-instance.
    const geometry = new THREE.PlaneGeometry(1, 1);
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';

    const planes = [];
    const materials = [];
    const textures = [];

    // Size the renderer to the hero, not the window — world-unit sizing means
    // everything else adapts automatically.
    const resize = () => {
        const w = hero.clientWidth;
        const h = hero.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    };

    // Progress 0→1 as the hero scrolls from "top top" to "bottom top".
    // Dependency-free equivalent of GSAP ScrollTrigger.
    let scrollProgress = 0;
    const updateScroll = () => {
        const r = hero.getBoundingClientRect();
        scrollProgress = clamp(-r.top / r.height, 0, 1);
    };

    const clock = new THREE.Clock();
    let elapsed = 0;
    let rafId = null;
    let disposed = false;

    // Exit-warp state.
    let lastSpeed = CONFIG.SPEED_IDLE;
    let warping = false;
    let warpElapsed = 0;
    let warpFromSpeed = CONFIG.SPEED_IDLE;
    let onWarpDone = null;

    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        window.removeEventListener('resize', resize);
        window.removeEventListener('scroll', updateScroll);
        for (const p of planes) scene.remove(p);
        geometry.dispose();
        for (const m of materials) m.dispose();
        for (const t of textures) t.dispose();
        renderer.dispose();
    };

    const tick = () => {
        // Clamp dt so a backgrounded tab can't teleport everything past the camera.
        const dt = Math.min(clock.getDelta(), 1 / 30);
        elapsed += dt;

        let speed;
        if (warping) {
            // Accelerate hard and fade the canvas — "punching through" the tunnel.
            warpElapsed += dt;
            const p = clamp(warpElapsed / WARP_DURATION, 0, 1);
            speed = lerp(warpFromSpeed, WARP_SPEED, easeInExpo(p));
            canvas.style.opacity = String(1 - p * p);
        } else {
            // Launch fast (SPEED_START), ease down to idle (SPEED_IDLE) over
            // SLOWDOWN_DURATION using easeOutExpo. Scrolling down eases the
            // drift further toward a gentle crawl (never stopping/reversing).
            const t = clamp(elapsed / CONFIG.SLOWDOWN_DURATION, 0, 1);
            const baseSpeed = lerp(CONFIG.SPEED_START, CONFIG.SPEED_IDLE, easeOutExpo(t));
            const drag = easeOutExpo(scrollProgress) * 40;
            speed = Math.max(baseSpeed - drag, 2);
            lastSpeed = speed;
        }

        if (planes.length) {
            // Find the furthest plane so any that passed the camera this frame
            // can be recycled behind it.
            let minZ = Infinity;
            for (const p of planes) {
                if (p.position.z < minZ) minZ = p.position.z;
            }

            for (const p of planes) {
                p.position.z += speed * dt;
                if (p.position.z > camera.position.z) {
                    // Recycled into the fog — invisible until it drifts closer.
                    p.position.z = minZ - CONFIG.SPACING;
                    minZ = p.position.z;
                }
            }
        }

        renderer.render(scene, camera);

        // Warp complete — tear down and hand control back to the caller.
        if (warping && warpElapsed >= WARP_DURATION) {
            const cb = onWarpDone;
            cleanup();
            if (cb) cb();
            return;
        }

        rafId = requestAnimationFrame(tick);
    };

    const build = (loaded) => {
        // Guard against the user navigating away mid-load.
        if (disposed) return;
        for (let i = 0; i < planeCount; i++) {
            // Random pick per plane — no visible repeating cycle along the tunnel.
            const tex = loaded[Math.floor(Math.random() * loaded.length)];
            // transparent + depthWrite:false gives soft layering, no z-fighting pop.
            const material = new THREE.MeshBasicMaterial({
                map: tex,
                transparent: true,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geometry, material);

            // Fixed x/y on the golden-angle ring; staggered z along the tunnel.
            const {x, y} = lane(CONFIG.RADIUS, i);
            mesh.position.set(x, y, -CONFIG.FOG_FAR - i * CONFIG.SPACING);

            // Aspect-corrected scaling — equivalent to object-fit: contain.
            // Uses the requested thumbnail aspect (always landscape) rather than
            // the decoded dimensions, which can intermittently report portrait.
            const size = CONFIG.IMAGE_SIZE + Math.random() * CONFIG.SCALE_RANDOMNESS;
            mesh.scale.set(size * THUMB_ASPECT, size, 1);

            scene.add(mesh);
            planes.push(mesh);
            materials.push(material);
        }
        // Begin the launch animation from the moment the planes appear, not from
        // page load. On a slow (uncached) load the loop renders empty fog frames
        // while textures download; without resetting `elapsed`, that wait is
        // counted against the slowdown and the planes spawn already at idle speed.
        elapsed = 0;
        clock.start();
    };

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', updateScroll, {passive: true});
    updateScroll();

    // Loop starts immediately and renders an empty (fog-coloured) frame until
    // textures finish loading — avoids a visible flash on slow connections.
    Promise.all(IMAGE_URLS.map((u) => loader.loadAsync(u)))
        .then((loaded) => {
            for (const tex of loaded) {
                // sRGB + LinearFilter + no mipmaps — matches the spec.
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.minFilter = THREE.LinearFilter;
                tex.generateMipmaps = false;
                textures.push(tex);
            }
            build(loaded);
        })
        .catch((err) => console.warn('[tunnel] texture load failed', err));

    rafId = requestAnimationFrame(tick);

    // Trigger the exit warp; `onComplete` fires once the canvas has faded out
    // and the tunnel has been torn down.
    const warpOut = (onComplete) => {
        if (disposed) {
            if (onComplete) onComplete();
            return;
        }
        if (warping) {
            onWarpDone = onComplete || onWarpDone;
            return;
        }
        warping = true;
        warpElapsed = 0;
        warpFromSpeed = lastSpeed;
        onWarpDone = onComplete || null;
    };

    return {dispose: cleanup, warpOut};
}
