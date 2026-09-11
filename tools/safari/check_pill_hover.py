#!/usr/bin/env python3
"""
Probe: does hovering a service pill on the method's LAST phase shift the whole
component by a pixel in Safari? (Reported 2026-09-07 on .c-method__service--e.)

Layout is measured (rects) AND the settled frame is diffed: a hover state is a
steady state, so a screenshot taken while the pointer rests on the pill does show
a paint-snap shift that getBoundingClientRect never will.

Run (with `safaridriver -p 9223` already running):
    python3 tools/safari/check_pill_hover.py [/about]
"""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))
from safari import Safari
from PIL import Image, ImageChops

# The real host, not the ddev.site alias: the module script is referenced on this
# origin, and from any other origin Safari refuses it — the page then runs no JS at
# all (html keeps `no-js`) and the slider never moves.
SITE = "https://jonleverrier2.local"
path = sys.argv[1] if len(sys.argv) > 1 else "/about"
OUT = "/tmp/pill-hover"
os.makedirs(OUT, exist_ok=True)

sf = Safari()
sf.window(1600, 1200)
sf.nav(SITE + path)
time.sleep(1.5)

# Last phase — step there with the Next button so the slider's own handlers run —
# and assert we arrived, then centre a white pill in the window.
sf.js("document.querySelector('.c-method').scrollIntoView({block:'center'}); return 1;")
time.sleep(0.8)
for _ in range(3):
    sf.js("var b=document.querySelector('.c-method button[aria-label=\"Next phase\"]');"
          "if(b&&!b.disabled)b.click(); return 1;")
    time.sleep(0.9)
state = sf.json_js(
    "var m=document.querySelector('.c-method');var ph=[].slice.call(m.querySelectorAll('.c-method__phase'));"
    "var i=ph.findIndex(function(p){return p.classList.contains('is-active')});"
    "var a=ph[i];return JSON.stringify({active:i,complete:m.classList.contains('is-complete'),"
    "title:(a.querySelector('h3,h2')||{}).textContent,pill:(a.querySelector('.c-method__service--e')||{}).textContent});")
print("state:", state)
assert state["active"] == 3 and state["complete"], "did not reach the last phase"
sf.js("var p=document.querySelector('.c-method__phase.is-active .c-method__service--e');"
      "p.scrollIntoView({block:'center'}); return 1;")
time.sleep(0.8)

def rects():
    return sf.json_js(
        "var o={};['.c-method','.c-method__viewport','.c-method__track','.c-method__phase.is-active',"
        "'.c-method__phase.is-active .c-method__services','.c-method__phase.is-active .c-method__num']"
        ".forEach(function(s){var e=document.querySelector(s);if(e){var b=e.getBoundingClientRect();"
        "o[s]={top:+b.top.toFixed(3),h:+b.height.toFixed(3)};}});o.scrollY=window.scrollY;return JSON.stringify(o);")

def pointer_to(x, y):
    sf._wd("POST", f"/session/{sf.sid}/actions", {"actions": [{
        "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
        "actions": [{"type": "pointerMove", "duration": 100, "x": int(x), "y": int(y)}]}]})

pill = sf.rect(".c-method__phase.is-active .c-method__service--e")
comp = sf.rect(".c-method")
print("pill:", {k: round(pill[k]) for k in ("x", "y", "width", "height")})

# Baseline with the pointer parked far away.
pointer_to(20, 20); time.sleep(0.6)
r0 = rects(); sf.shot(f"{OUT}/0-before.png")
# Hover the pill. While its 400ms spring runs, sample the component's top and the
# phase number's top every frame — a transient layout wobble shows here as a range
# above 0, where the settled rects and screenshots below can't see it.
sf.js("window.__s=[];window.__go=true;(function f(){if(!window.__go)return;"
      "var m=document.querySelector('.c-method'),n=document.querySelector('.c-method__phase.is-active .c-method__num');"
      "window.__s.push([m.getBoundingClientRect().top,n.getBoundingClientRect().top,window.scrollY]);requestAnimationFrame(f);})();return 1;")
pointer_to(pill["x"] + pill["width"] / 2, pill["y"] + pill["height"] / 2); time.sleep(0.9)
samples = sf.json_js("window.__go=false;return JSON.stringify(window.__s);")
tops = [round(x[0], 3) for x in samples]; nums = [round(x[1], 3) for x in samples]; sy = [x[2] for x in samples]
print(f"frames sampled through the hover: {len(samples)} | .c-method top range {min(tops)}..{max(tops)}"
      f" | num top range {min(nums)}..{max(nums)} | scrollY {min(sy)}..{max(sy)}")
r1 = rects(); sf.shot(f"{OUT}/1-hover.png")
# Leave again.
pointer_to(20, 20); time.sleep(0.9)
r2 = rects(); sf.shot(f"{OUT}/2-after.png")

for name, a, b in (("hover", r0, r1), ("after", r0, r2)):
    diff = {k: (a[k], b[k]) for k in a if a[k] != b[k]}
    print(f"rect changes {name}:", diff or "none")

# Pixel shift of the component's TEXT (title + prose, clear of the pill row): crop the
# same box from each shot and find the vertical offset that best matches the baseline.
dpr = sf.js("return window.devicePixelRatio;")
def crop(img):
    x0 = int((comp["x"] + 40) * dpr); x1 = int((comp["x"] + comp["width"] - 40) * dpr)
    y0 = int((comp["y"] + 20) * dpr); y1 = int((pill["y"] - 12) * dpr)   # everything above the pill row
    return img.crop((x0, y0, x1, y1)).convert("L")
base = crop(Image.open(f"{OUT}/0-before.png"))
for name in ("1-hover", "2-after"):
    img = crop(Image.open(f"{OUT}/{name}.png"))
    best = None
    for dy in range(-4, 5):
        a = base.crop((0, 4, base.width, base.height - 4))
        b = img.crop((0, 4 + dy, img.width, img.height - 4 + dy))
        score = sum(ImageChops.difference(a, b).histogram()[i] * i for i in range(256))
        if best is None or score < best[1]:
            best = (dy, score)
    print(f"{name}: text above the pills best matches baseline at dy={best[0]} device px "
          f"({best[0]/dpr:.2f} css px); residual={best[1]}")
print("shots in", OUT)
