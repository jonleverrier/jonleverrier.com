#!/usr/bin/env python3
"""
Worked example: reproduce the c-method Safari stack and probe for vertical jitter.

Builds the "testimonial + clients marquee ABOVE the method" stack — the one that
surfaced the compositor bob — then samples the method number's top position over
100 frames while the marquee scrolls and the ping loops. A `range` above ~0.5px
means real layout wobble; near-0 means the content is steady.

Run (with `safaridriver -p 9223` already running in another terminal):
    python3 tools/safari/check_method_jitter.py
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
from safari import Safari
from jonson_stack import fetch_component, inject_stack, SITE

sf = Safari()
sf.window(1600, 1200)
sf.nav(SITE)
# each fetch_component resets to a fresh session internally (fresh=True), so the
# three questions each stream their panel as a first message

method  = fetch_component(sf, "What is your process for a project?", "method")
clients = fetch_component(sf, "Which brands and clients have you worked with?", "clients")
testi   = fetch_component(sf, "Why should I hire you? Show me client testimonials.", "testimonial")
print("fetched -> method:", bool(method), "clients:", bool(clients), "testi:", bool(testi))

print("injected ->", inject_stack(sf, [testi, clients, method]))

# centre the method node, keep the marquee on-screen and animating
sf.js("var n=document.querySelector('.c-method__phase .c-method__node');"
      "if(n){n.scrollIntoView({block:'center'});window.scrollBy(0,-40);}return 1;")

# let the freshly-injected stack settle (slider fade-in, layout) before probing,
# otherwise the first frames catch macro layout motion, not compositor jitter
time.sleep(1.2)

result = sf.sample_top(".c-method__phase.is-active .c-method__num", frames=100)
print("method number top over 100 frames:", result)
if result:
    # sub-pixel wobble = compositor jitter; a large range = a real layout shift
    # (e.g. slider resizing) — different bug, don't conflate them
    verdict = "STEADY" if result["range"] <= 0.5 else (
        "LAYOUT SHIFT" if result["range"] > 4 else "JITTER")
    print(f"verdict: {verdict}  (range={result['range']}px)")
