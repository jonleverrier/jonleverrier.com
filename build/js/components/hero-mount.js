// Decides what the homepage hero is on this machine, and mounts it:
//
//   · a GPU       → the animated point cloud (hero.js, which brings three);
//   · no GPU      → one still frame, drawn in a worker (hero-still.worker.js);
//   · no WebGL    → the plain olive slab.
//
// Kept apart from hero.js so that three is only downloaded when it will animate.
// hero.js imports three statically, so anything that imported hero.js — even just to
// reach the check — fetched 123kB the no-GPU path never runs: PageSpeed flagged it as
// unused JavaScript, and it shared the connection with the binary the still waits on.
// Everything here is three-free; hero.js is a dynamic import on the GPU branch only.

import {probeTier} from "./hero-tier.js";
import {loadCloudBuffer} from "./hero-bin.js";

// HAND-EDITED, not from the exporter — re-apply if hero.js is regenerated.
//
// The binary as a bundled asset rather than a fixed public path. Two reasons:
//   · the built filename carries a content hash, so replacing the cloud changes the
//     URL and no browser can serve a stale copy of the old one;
//   · the path isn't sitting in the markup for anyone reading source.
//
// The second is obscurity, not protection — the browser has to fetch the file to draw
// it, so the URL is always one network-tab glance away. It just isn't handed over.
import HERO_BIN_URL from "../../assets/hero.bin?url";

// What is behind WebGL, asked in a worker: 'hardware' or 'software', or null when the
// worker could not tell — no module workers, no OffscreenCanvas, or no WebGL on one
// (Safari 16.4 has OffscreenCanvas but only 2D), in which case the caller asks on the
// main thread as it always did.
//
// WHY A WORKER. Creating the first WebGL context blocks until the GPU process has a
// renderer ready, and on a machine with no GPU that means SwiftShader starting up.
// Measured on this homepage (SwiftShader, 4x CPU throttle, Long Tasks API): on the
// main thread the probe was a single 1.2-2.0s task, every run, starting ~230ms in. In
// a worker the page logged no long tasks at all — the worker does the waiting. On a
// real GPU the probe is a few milliseconds either way.
function probeOffMainThread() {
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") return Promise.resolve(null);
  let worker;
  try {
    worker = new Worker(new URL("./hero-probe.worker.js", import.meta.url), {type: "module"});
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const done = (tier) => {
      worker.terminate();
      resolve(tier === "hardware" || tier === "software" ? tier : null);
    };
    worker.onmessage = (e) => done(e.data);
    worker.onerror = () => done(null);
    worker.onmessageerror = () => done(null);
  });
}

// Neither animation nor still: the olive slab behind the hero, which is the canvas's
// clear colour anyway, so its absence reads as a plain backdrop.
//
// warpOut still has to call back. app.js hands it the function that reveals the
// thread, and the no-op this used to be stranded a visitor on a fading front door with
// no conversation behind it — every visitor without a GPU, on their first question.
const slab = () => ({warpOut(cb) { if (cb) cb(); }, dispose() {}});

// Matches WARP_MS in hero.js — the still fades over the time the animation would have
// taken to fly through, so the conversation arrives on the same beat either way.
const STILL_EXIT_MS = 700;

// NO GPU: ONE FRAME, DRAWN IN A WORKER.
//
// 37k points redrawn every frame is a few milliseconds on a GPU and 75ms without one —
// measured against production under SwiftShader, i.e. 13fps, with Lighthouse logging
// twenty consecutive 220-266ms main-thread tasks from this file. So there is no
// animation here: the settled portrait is drawn once and left on the canvas.
//
// It used to decline outright, which left a hole where the hero belongs in every
// headless capture — PageSpeed Insights' screenshots and the audit tool's both run on
// SwiftShader — and a blank slab for real visitors with no GPU (old drivers, a
// blocklisted GPU, a VM, hardware acceleration off).
//
// Drawn in a worker, NOT here, because a still on the main thread was measured and was
// not free: the shader link in software blocks whichever thread asks about it, and
// three asks on first use — ~100ms of main thread held in one getProgramParameter,
// in about half the runs. In a worker that wait is the worker's. The main thread only
// fetches the binary and hands it over, zero-copy.
//
// No OffscreenCanvas transfer (Safari before 17) falls back to the slab: the main-thread
// still is the thing this exists to avoid.
async function createStill(container, binUrl) {
  if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype)) return slab();
  let worker;
  try {
    worker = new Worker(new URL("./hero-still.worker.js", import.meta.url), {type: "module"});
  } catch {
    return slab();
  }
  const buf = await loadCloudBuffer(binUrl);

  // Laid out exactly as the animated canvas is — see resize() in hero.js for why
  // it is centred and holds the tallest height it has seen at a given width.
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    position: "absolute", inset: "auto", left: "0", top: "50%",
    width: "100%", transform: "translateY(-50%)",
    opacity: "0", transition: "opacity 80ms linear",
  });
  container.appendChild(canvas);
  const offscreen = canvas.transferControlToOffscreen();

  let heldW = 0, heldH = 0;
  function resize() {
    const w = container.clientWidth;
    let hgt = container.clientHeight;
    if (!w || !hgt) return;
    if (w === heldW && hgt <= heldH) return;
    if (w === heldW) hgt = Math.max(hgt, heldH);
    heldW = w; heldH = hgt;
    canvas.style.height = hgt + "px";
    worker.postMessage({type: "size", width: w, height: hgt});
  }

  let failed = false;
  worker.onmessage = (e) => {
    if (e.data === "drawn") canvas.style.opacity = "1";
    else if (e.data === "failed") { failed = true; canvas.remove(); worker.terminate(); }
  };
  worker.onerror = () => { failed = true; canvas.remove(); worker.terminate(); };

  worker.postMessage({type: "init", canvas: offscreen, buf, dpr: Math.min(devicePixelRatio, 2)}, [offscreen, buf]);
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let exitTimer = 0;
  return {
    warpOut(cb) {
      if (failed) { if (cb) cb(); return; }
      canvas.style.transition = `opacity ${STILL_EXIT_MS}ms ease-in`;
      canvas.style.opacity = "0";
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { if (cb) cb(); }, STILL_EXIT_MS);
    },
    dispose() {
      ro.disconnect();
      clearTimeout(exitTimer);
      worker.terminate();
      canvas.remove();
    },
  };
}

export async function mountHero(container) {
  // DECIDE BEFORE SPENDING ANYTHING. Checked FIRST, so on a machine that is not going
  // to animate, neither three nor the 37k-point unpack ever reaches this thread. The
  // worker is asked first; the main-thread probe is only the fallback for browsers
  // where it cannot answer.
  const tier = (await probeOffMainThread()) ?? probeTier(document.createElement("canvas"));
  if (tier === "none") return slab();
  if (tier === "software") return createStill(container, HERO_BIN_URL);
  const {createHero} = await import("./hero.js");
  return createHero(container, HERO_BIN_URL);
}
