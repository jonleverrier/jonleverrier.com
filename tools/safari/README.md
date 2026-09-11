# Safari test harness

Drive a real Safari via `safaridriver` to catch **Safari-only** rendering bugs
(compositor jitter, mask re-raster, layer paint order) that never reproduce in
Chrome and that the Claude-in-Chrome extension can't see.

## Files

| File | What it is |
|------|------------|
| `safari.py` | Reusable WebDriver wrapper — session lifecycle, run JS, measure rects, screenshot. Site-agnostic. |
| `jonson_stack.py` | Site-specific: fetch real jonson components via the `/jonson/ask` SSE endpoint and inject any stack into the thread. |
| `check_method_jitter.py` | Worked example — reproduces the c-method stack and probes for vertical jitter. |

## One-time setup

1. Safari → Settings → **Advanced** → tick **"Show features for web developers"**.
2. Safari → **Develop** menu → tick **"Allow Remote Automation"**.
3. `safaridriver --enable` (prompts for sudo once).

## Every session

Start the driver in its own terminal and leave it running:

```sh
safaridriver -p 9223
```

Then run a script:

```sh
python3 tools/safari/check_method_jitter.py
```

The first `Safari()` opens an automation window (or reuses the session saved in
`/tmp/safari_session.txt`). Requires `Pillow` only if you diff screenshots
(`pip3 install Pillow`); the rect-based probes need nothing beyond stdlib.

## The one rule that matters

**WebDriver screenshots settle the frame** — they cannot capture a live
compositor transient (a one-off flicker mid-animation). For anything visual,
**measure layout** with `rect()` / `sample_top()` (getBoundingClientRect is
stable and reveals real position wobble) rather than trusting a screenshot to
"look" janky. Screenshots answer *"what does the settled frame look like"*, not
*"is it flickering"*.

## Quick recipe

```python
from safari import Safari
from jonson_stack import fetch_component, inject_stack, SITE

sf = Safari()
sf.window(1600, 1200)
sf.nav(SITE)

method  = fetch_component(sf, "What is your process?", "method")
clients = fetch_component(sf, "Which clients have you worked with?", "clients")
inject_stack(sf, [clients, method])          # top -> bottom

print(sf.sample_top(".c-method__phase.is-active .c-method__num"))  # {range: ...}
sf.shot("stack.png")
```
