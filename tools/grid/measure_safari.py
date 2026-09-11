#!/usr/bin/env python3
"""Idle frame cost of a page in real Safari (where the grid's 26ms/frame was seen).
   safaridriver -p 9223   # in another terminal
   python3 tools/grid/measure_safari.py [url] [scrollY] [padContainerToPx]
"""
import sys, json
sys.path.insert(0, 'tools/safari')
from safari import Safari

url = sys.argv[1] if len(sys.argv) > 1 else 'https://jonleverrier2.local/case-study/vaiie-product-branding'
scroll = int(sys.argv[2]) if len(sys.argv) > 2 else 0
# Optional: pad the grid container to this height (px) to reproduce a longer article.
pad = int(sys.argv[3]) if len(sys.argv) > 3 else 0
sf = Safari()
sf.window(1728, 1000)
sf.nav(url)
import time
# Walk the page so every lazy image loads and the container reaches full height.
h = sf.js("return document.documentElement.scrollHeight")
for y in range(0, int(h), 800):
    sf.js("window.scrollTo(0, arguments[0])", [y]); time.sleep(0.25)
time.sleep(1.5)
if pad:
    sf.js("""const c = document.querySelector('[data-content-grid]'); const d = document.createElement('div');
      d.style.height = Math.max(0, arguments[0] - c.getBoundingClientRect().height) + 'px'; c.appendChild(d);""", [pad])
    time.sleep(1)
sf.js("window.scrollTo(0, arguments[0])", [scroll])
time.sleep(2.5)
res = sf.js_async("""
const done = arguments[arguments.length - 1];
const c = document.querySelector('canvas.c-jonson__grid');
const info = c ? { bitmap: [c.width, c.height], cssH: c.style.height, transform: c.style.transform, pageH: document.documentElement.scrollHeight, imgs: [...document.images].filter(i => !i.complete).length + ' unloaded' } : 'NO CANVAS';
const deltas = [];
let last = performance.now(), n = 0;
const f = (t) => { deltas.push(t - last); last = t; if (++n < 120) requestAnimationFrame(f); else {
  deltas.sort((a, b) => a - b);
  const q = p => +deltas[Math.floor(deltas.length * p)].toFixed(1);
  done({ info, median: q(0.5), p90: q(0.9), max: +deltas[deltas.length - 1].toFixed(1) });
} };
requestAnimationFrame(f);
""")
print(json.dumps(res))
