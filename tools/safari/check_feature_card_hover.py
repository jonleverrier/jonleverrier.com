#!/usr/bin/env python3
"""
Probe: hovering a c-case-studies--feature card shifts the logo / client / title by
about a pixel in Safari. (Reported 2026-09-15, after the title moved out of
.c-case-study__reveal so logo+client+title show at rest.)

Chrome shows nothing: 33 presented frames at DPR 1 and 2, logo top identical in
every one. A hover is a STEADY state, so the settled frame is the thing to diff —
getBoundingClientRect is stable across a paint-snap and will report no movement.

Run (with `safaridriver -p 9223` already running):
    python3 tools/safari/check_feature_card_hover.py [/zzfeaturetest]
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
from safari import Safari
from PIL import Image, ImageChops

SITE = "https://jonleverrier2.local"
path = sys.argv[1] if len(sys.argv) > 1 else "/zzfeaturetest"
OUT = "/tmp/feature-hover"
os.makedirs(OUT, exist_ok=True)

sf = Safari()
sf.window(1600, 1200)
sf.nav(SITE + path)
time.sleep(2.0)

# Freeze anything that animates on its own, or it lands in the diff and reads as a
# hover artefact. The header logo cycles its description on a timer (see
# cycle-logo-description.js) and did exactly that between the two shots first time.
sf.js("document.querySelectorAll('.b-logo, .c-jonson__orb').forEach(function(e){"
      "e.style.visibility='hidden';}); return 1;")
sf.js("document.querySelector('.c-case-studies--feature .c-case-study')"
      ".scrollIntoView({block:'center'}); return 1;")
time.sleep(1.0)

sel = ".c-case-studies--feature .c-case-study"
before = sf.json_js(
    "var c=document.querySelector(arguments[0]);"
    "var r=function(s){var e=c.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();"
    "return {top:+b.top.toFixed(2),left:+b.left.toFixed(2)};};"
    "return JSON.stringify({logo:r('.c-case-study__logo'),client:r('.c-case-study__client'),"
    "title:r('.c-case-study__title')});", [sel])
print("  at rest :", before)
sf.shot(f"{OUT}/rest.png")

# A REAL pointer move — synthetic MouseEvents do not set CSS :hover in Safari, which
# is why the first version of this probe diffed two identical rest frames.
def pointer_to(x, y):
    sf._wd("POST", f"/session/{sf.sid}/actions", {"actions": [{
        "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
        "actions": [{"type": "pointerMove", "duration": 100, "x": int(x), "y": int(y)}]}]})

card = sf.rect(sel)
pointer_to(20, 20); time.sleep(0.6)

# Sample every frame THROUGH the 340ms scrim transition. The settled frames either
# side cannot show a transient; this can.
sf.js("window.__s=[];window.__go=true;(function f(){if(!window.__go)return;"
      "var c=document.querySelector('.c-case-studies--feature .c-case-study');"
      "var g=function(q){var e=c.querySelector(q);return e?e.getBoundingClientRect().top:-1;};"
      "window.__s.push([g('.c-case-study__logo'),g('.c-case-study__client'),"
      "g('.c-case-study__title'),window.scrollY]);requestAnimationFrame(f);})();return 1;")
pointer_to(card["x"] + card["width"]/2, card["y"] + card["height"]/2)
time.sleep(1.0)
samples = sf.json_js("window.__go=false;return JSON.stringify(window.__s);")
for i, name in enumerate(("logo", "client", "title")):
    vals = [round(v[i], 3) for v in samples]
    print(f"  {name:7s} through hover: min {min(vals)}  max {max(vals)}  range {round(max(vals)-min(vals),3)}px  ({len(vals)} frames)")
after = sf.json_js(
    "var c=document.querySelector(arguments[0]);"
    "var r=function(s){var e=c.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();"
    "return {top:+b.top.toFixed(2),left:+b.left.toFixed(2)};};"
    "return JSON.stringify({logo:r('.c-case-study__logo'),client:r('.c-case-study__client'),"
    "title:r('.c-case-study__title')});", [sel])
print("  on hover:", after)
sf.shot(f"{OUT}/hover.png")

a = Image.open(f"{OUT}/rest.png").convert("RGB")
b = Image.open(f"{OUT}/hover.png").convert("RGB")
if a.size != b.size:
    print("  size mismatch", a.size, b.size)
else:
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    print(f"\n  settled-frame diff bbox: {bbox}")
    if bbox:
        # Which rows changed, and by how much — a paint-snap shows as a thin band.
        w, h = diff.size
        rows = []
        px = diff.load()
        for y in range(bbox[1], bbox[3]):
            s = 0
            for x in range(bbox[0], bbox[2], 4):
                p = px[x, y]
                s += p[0] + p[1] + p[2]
            if s > 0:
                rows.append((y, s))
        rows.sort(key=lambda r: -r[1])
        print(f"  changed rows: {len(rows)}   busiest y: {[r[0] for r in rows[:12]]}")
    diff.save(f"{OUT}/diff.png")
    print(f"  wrote {OUT}/rest.png, hover.png, diff.png")
