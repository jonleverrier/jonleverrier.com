# jonson-grid performance — findings & plan

Audit of `build/js/components/jonson-grid.js` (the decorative dot canvas), 2026-09-02.

## STATUS — fixed 2026-09-02

`jonson-grid.js` was rewritten. Findings #1–#5 are addressed; #6 dissolved with #1.
The audit below is kept as the record of *why*.

What changed:
- **Viewport window (#1).** Bitmap is container-width × min(container, viewport) height,
  translated to the on-screen slice each frame; only the visible row band is iterated.
  Sweep/pulse maths still use the full container box, `ox`/`oy` still indexed by absolute
  `(i, j)`. `rootMargin: 50%` on the IO.
- **Batched draw (#2).** Resting dots quantised into 128 alpha steps → one `Path2D` per
  step, one fill each with `globalAlpha`. Dots under the cursor / in the pulse band draw
  individually (radius varies). Per-dot fallback when `Path2D` is missing. Hypot only
  within ±11 cells of the cursor.
- **One layout read per frame (#3).** The loop's `getBoundingClientRect` positions the
  slice, catches size changes, and feeds the pointer handler — `onMove` reads no layout.
- **No module-scope reflow (#4).** First build/draw/`is-interactive` happen in the first
  ResizeObserver callback (after layout, before paint). The CSS-dots → canvas hand-off
  is preserved: the class is only added after the canvas has painted.
- **Pointer gate (#5).** No mount at all without `(hover: hover) and (pointer: fine)`;
  the CSS grid stays. Cost: the contact-form pulse beat doesn't fire on touch devices.
- **Frame cap — deliberately NOT done.** Throttling draws while the bitmap is being
  re-positioned by scroll would make the grid lag content by a frame on 120Hz displays.
  After the fixes above 120Hz is affordable.

Measured (1728 window, vaiie study as it is today — 6 blocks, ~5.3k px tall):

| | before | after |
|---|---|---|
| bitmap | 3388 × 10576 (35.8 MP) | 3388 × 1714 (5.8 MP), constant |
| arcs / frame | 13,735 | 2,278 |
| fills / frame | 13,735 | 1 (+ ~300 individual dots under the cursor) |
| Safari idle | 17 ms | 17 ms |
| Safari idle, container padded to 14,580 px | sample could not complete | 17 ms |

Chrome on this Mac is GPU-accelerated and held 120 fps before and after, so the frame
delta doesn't discriminate there; the draw counts do. The audit's 26 ms Safari figure
did not reproduce with today's content (the page is ~5.8k px, not 14.6k), which is why
the padded run is there. Warp verified from canvas pixels: a dot 3 cells from the cursor
moves 5.4 px toward it (5.6 expected) and returns to rest. Sweep verified: up to 27 alpha
buckets in view as the band crosses. Home `.c-jonson` mount verified after an ask.

Tooling: `tools/grid/` (see its README). Next: re-evaluate the reverted image changes
from this clean baseline.

---

## The problem in one paragraph

`mountGrid` sizes its canvas to its **container's full box** and iterates every cell of
that box every frame. That's fine for `.c-jonson`, which is roughly viewport-sized. It is
not fine for `.c-content`, which is *the whole article*. On a case study the canvas becomes
**3388 × 14580 (49.4 MP, ~188 MB)** and `draw()` renders **18,894 dots per frame, 87% of
them off screen**. The page sits at **26ms/frame while completely idle** — nothing
scrolling, nothing animating — where a synthetic blank page of identical height holds 17ms.

Two mount sites, very different containers:

| site | container | scale |
|---|---|---|
| `build/js/components/jonson-ask.js:643` | `.c-jonson` — viewport-ish | fine |
| `build/js/app.js:157` | `.c-content` — the whole article | **everything below is amplified 4–8×** |

## How this was found (and why it looked like an image problem)

The reported symptom was "the vaiie case study is struggling with all the images", and
"if I remove one block it loads smoothly". Neither is about images:

- Still 26ms/frame with **every `<img>` removed from the DOM** and heights preserved.
- Still 26ms with all CSS animations off, the marquee hidden, backgrounds stripped.
- A height-compensated DOM bisect (hide a node, insert a spacer of equal height, sample
  rAF deltas) lands on exactly one element: `canvas.c-jonson__grid`.
- One content block ≈ 920px ≈ 35 rows ≈ 2,300 dots/frame — enough to tip the median frame
  back under the 30fps line. That's the apparent "cliff".
- The case studies index runs smooth because its grid is a quarter the size (4,489 dots).

Per-page measurements at a 1728 window:

| page | canvas | dots/frame | off-screen |
|---|---|---|---|
| vaiie case study | 3388 × 14580 (~188 MB) | 18,894 | 87% |
| white paper | 3388 × 10662 (~138 MB) | 13,869 | 82% |
| case studies index | 3388 × 3414 (~44 MB) | 4,489 | 45% |
| home (`.c-jonson`) | 2 × 2 | 1 | — |

Draw loop isolated in Safari: **286 rows = 3.00ms/frame; the 37 visible rows = 0.00ms.**
Canvas backing-store size made no difference to frame time — it's the loop, not the
allocation. (Memory is still worth reclaiming.)

---

## Findings

Priority order. Fix #1 first — it changes what every other number means.

### 1. Canvas sized to the container, not the viewport — ROOT CAUSE
`jonson-grid.js:88-95` (`build()`), `:135` (row loop bound `j < rows`).

Cost and memory are both O(page length). Also **structurally defeats the visibility gate**:
`io.observe(container)` at `:221-222` observes an element that *is* the page, so it is
permanently intersecting and the loop never stops. The comment at `:15` ("the loop runs
only while the section is on-screen") holds for `.c-jonson` and is false for `.c-content`.

Related, same line of work:
- No `rootMargin` on the IO (`:221`).
- **No frame-rate cap** anywhere — on a ProMotion display this runs at 120fps for double
  the work. Not observed locally (this Safari reported 60Hz) but a real exposure.

### 2. Per-cell fills and per-frame string allocation
`jonson-grid.js:176-179` — `beginPath` / template-literal `fillStyle` / `arc` / `fill`,
per cell per frame. ~18,894 string allocations and fills per frame (~1.13M strings/sec
at 60fps).

Fix is alpha-bucketing + `Path2D` per bucket + `ctx.globalAlpha` with one constant
`fillStyle`, **but** radius also varies per cell (`:174`,
`r = dotRadius + nearRadius*near + PULSE_DR*grow`). The split is clean:
- dots at rest → constant radius, alpha varies only with the sweep → bucket these
- only cells inside `WARP_RADIUS` or the pulse band → variable radius → draw individually

Keep a per-dot fallback if `Path2D` is missing.

Also here: `:148-157` computes `Math.hypot` for **every** cell whenever the pointer is
non-null. `WARP_RADIUS` is 260px ≈ 10 cells, so a ±11 row/col window around the cursor
eliminates ~18,500 hypot calls per frame.

### 3. Two forced layouts per frame
- `jonson-grid.js:113-119` — `onMove` calls `getBoundingClientRect()` on **every**
  pointermove, and is bound to `window` (`:231`) so it fires for movement anywhere on the
  page. Cache the rect; invalidate from passive listeners. **Note: must invalidate on
  scroll as well as resize** — `.c-content` is in normal flow, so its top moves with scroll.
- `jonson-grid.js:197-203` — `resizeIfNeeded()` does another `getBoundingClientRect()`, and
  `:205` calls it **every frame**.

### 4. Forced reflow at module scope
`app.js:155-157` calls `mountGrid` at top level of the entry module; `jonson-grid.js:234`
calls `build()` synchronously, which reads `getBoundingClientRect()` at `:89`. Vite emits
`type="module"` (deferred, pre-DOMContentLoaded) — Lighthouse will attribute a forced
reflow to the script.

**Constraint on the fix:** `:238` runs `draw(0)` *before* `:239` adds `is-interactive`,
deliberately, so the CSS `::before` dots aren't hidden until the canvas has painted once
(`:235-237` — that gap read as a blink on load). Deferring the first measurement must keep
that hand-off intact. A bare `requestAnimationFrame(measure)` is **not** a fix: rAF doesn't
fire in a background tab, so the canvas would sit unmeasured until focus.

### 5. No `(pointer: fine)` gate
`jonson-grid.js:231-232` wire `pointermove`/`pointerleave` unconditionally. On touch
devices the warp can never be seen, but the listeners and the whole rAF loop still run.

### 6. Resize not coalesced — REAL ONLY ON MOBILE
`:219` `rebuild = () => { build(); draw(lastT); }`, `:228` `new ResizeObserver(rebuild)` —
a full bitmap realloc plus an 18,894-dot draw, synchronously in the callback.

**`:211-217` documents this as deliberate**: deferring it leaves a frame where the fixed
bitmap is CSS-stretched to a growing box, so the dots visibly drift then snap. Genuine
trade-off, not an oversight. Measured: the RO fires **once** per full page load, not per
image — no load-time thrash. The exposure is a mobile URL-bar resize hitching on a
synchronous ~188MB realloc. Fixing #1 shrinks that realloc and largely dissolves this.

---

## Explicitly NOT problems (don't "fix" these)

- **State churn on resize** — `build()` reallocs `ox`/`oy` (`:99-100`), resetting warp
  displacement, but there is **no random per-cell state**. No twinkle phases or speeds; the
  sweep is a pure function of `t` and position (`:131-133`, `:161-163`). A spurious resize
  cannot reshuffle the animation. Worst case a few displaced dots snap to rest.
- **Skip near-zero alpha** — `baseAlpha` is 0.8 on the content grid and 0.10 on `.c-jonson`.
  No cell ever rounds to zero. Pure overhead.
- **Canvas allocation limits** — desktop Safari honoured 8000 × 32768 (262 MP) in testing.
  49.4 MP is nowhere near failing. *Untested: iOS Safari, which has tighter limits.*

## Already correct — verified, leave alone

| item | where |
|---|---|
| reduced-motion bails entirely (returns no-op, leaves CSS grid) | `:46-48` |
| devicePixelRatio clamped to 2 | `:92` |
| pointer listeners passive | `:231-232` |
| typed arrays (`Float32Array`), not object arrays | `:81-82`, `:99-100` |
| first hover snaps to cursor, no ease-in from off-canvas | `px`/`py` init `null` `:112`; target from real cursor position `:149-155` |

---

## Proposed plan for #1 — viewport window, not page-sized bitmap

Keep the grid in page coordinates; only ever allocate and draw the slice on screen.

1. **Backing store = container ∩ viewport**, capped at viewport height. Constant
   ~3456 × 1840 (6.4 MP, ~25 MB) instead of 49.4 MP / ~188 MB — and constant for a 3-block
   study or a 30-block one.
2. **Position by scroll.** Keep `position: absolute`; each frame write
   `transform: translate3d(0, <offsetWithinContainer>px, 0)`. One style write on a
   composited element, no layout.
3. **Iterate only the visible row band** — `j` from `floor(offset/26) - 1` to
   `ceil((offset + canvasH)/26) + 1`. ~2,500 dots instead of 18,894.
4. **Keep the sweep maths on the full container box.** `projMin`/`projSpan` stay computed
   from the whole article's `w × h`, so the 16s diagonal still travels across the entire
   page exactly as today. This is what makes it a *window* rather than a *crop* — the
   visual should be identical, not an approximation.
5. **`ox`/`oy` stay indexed by absolute `(i, j)`** so warp state survives scrolling.
   18k floats = 144 KB, not worth optimising.

Result: memory and frame cost both O(viewport) instead of O(page). Once this lands, the IO
gate at `:221` becomes meaningful again and #6 largely dissolves.

**Open question, not yet decided:** whether the pointer warp justifies a canvas at all. The
more radical option keeps the CSS `radial-gradient` dot field for the static grid (zero JS,
scales infinitely) and uses a small canvas that only follows the cursor — ~400 dots,
independent of both page *and* viewport. The catch is the moved dots must be punched out of
the CSS layer beneath, i.e. a cursor-following `mask-image` over the whole container, and
masks have history on this project (see the `mask-clip:no-clip` Safari note). Not
recommended as a starting point.

---

## Re-measuring

Harness: `tools/safari/` (start with `safaridriver -p 9223`) plus puppeteer against the
local site via `/Applications/Google Chrome.app`. Node needs
`process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` to intercept the local HTTPS document.

Useful probes, all used above:
- **Idle frame cost** — sample `requestAnimationFrame` deltas for ~1.5s with the page
  scrolled to top and nothing interacting. Should be 17ms. Currently 26ms.
- **Height-compensated DOM bisect** — hide a node, insert a spacer of its exact height,
  re-sample. This is what isolated the canvas when hiding images, animations, marquees and
  backgrounds all changed nothing.
- **Draw-loop microbenchmark** — replicate the `arc`/`fill` loop at N rows on a detached
  canvas and time it, to separate loop cost from backing-store cost.

**Baseline warning:** the vaiie case study currently has **6 content blocks, not 7** — one
was removed by hand while testing. Put it back before measuring or the baseline flatters.

---

## Related work, reverted on purpose

Two image-side changes were built, measured and then **reverted** (working tree is clean of
them; 80 orphaned transform files deleted, `public/assets/case-studies` back to 127M):

- `2560`/`2880` rungs added to the `largeImage` srcset ladder in
  `craft/templates/_components/case-content.twig`
- `content-visibility: auto` on `.c-case-content > .c-case-content__figure` in
  `build/scss/components/_case-content.scss`

They weren't wrong — they cut 40.3 → 25.8 MP and Safari decode 285 → 185ms — but they
addressed a **~285ms one-off decode** while the grid burns **~9ms of every frame**, and
every load/scroll number used to justify them was measured against that contaminated
baseline. The extra rungs also cost 2 more AVIF+WebP encodes per image for a deploy warm
step that isn't built yet.

**Re-evaluate them only after the grid is fixed**, from a clean baseline.
