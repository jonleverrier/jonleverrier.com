#!/usr/bin/env python3
"""
Reusable Safari WebDriver harness (safaridriver over HTTP/JSON).

Why this exists
---------------
The Claude-in-Chrome extension can't see Safari, and Safari-only compositor
bugs (jitter, mask re-raster, layer paint order) don't reproduce in Chrome.
This drives a real Safari via `safaridriver` so we can navigate, run JS in the
page, measure element rects, and screenshot — the same primitives we used to
chase the c-method jitter.

Prerequisites (one-time)
------------------------
  1. Safari > Settings > Advanced > "Show features for web developers"
  2. Safari > Develop menu > "Allow Remote Automation"  (must be ticked)
  3. In a terminal:  safaridriver --enable   (asks for sudo once)
  4. Start the driver on the port this module uses (default 9223):
         safaridriver -p 9223
     Leave it running in its own terminal/tab.

Then, in Python:
    from safari import Safari
    sf = Safari()                       # reuses a saved session or makes one
    sf.nav("https://jonleverrier2.local.ddev.site/")
    print(sf.js("return document.title"))
    sf.shot("out.png")

Key limitation (learned the hard way)
-------------------------------------
WebDriver screenshots *settle* the frame — they cannot capture a live
compositor transient (a one-off jitter mid-animation). For anything visual,
measure LAYOUT instead: `rect()` / `measure_top()` read getBoundingClientRect,
which is stable and reveals real position wobble. Use screenshots for
"what does the settled frame look like", not "is it flickering".
"""
import base64
import json
import time
import urllib.request

DEFAULT_PORT = 9223
SESSION_FILE = "/tmp/safari_session.txt"


class Safari:
    def __init__(self, port=DEFAULT_PORT, session_file=SESSION_FILE, reuse=True):
        self.base = f"http://localhost:{port}"
        self.session_file = session_file
        self.sid = None
        if reuse:
            try:
                self.sid = open(session_file).read().strip()
                self.js("return 1")  # probe — throws if the session is dead
            except Exception:
                self.sid = None
        if not self.sid:
            self._new_session()

    # ---- transport -------------------------------------------------------
    def _wd(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)

    def _new_session(self):
        r = self._wd("POST", "/session",
                     {"capabilities": {"alwaysMatch": {"browserName": "safari"}}})
        self.sid = r["value"]["sessionId"]
        open(self.session_file, "w").write(self.sid)
        return self.sid

    # ---- page control ----------------------------------------------------
    def nav(self, url):
        self._wd("POST", f"/session/{self.sid}/url", {"url": url})

    def js(self, script, args=None):
        """Run JS synchronously; `return ...` gives the value back."""
        return self._wd("POST", f"/session/{self.sid}/execute/sync",
                        {"script": script, "args": args or []})["value"]

    def js_async(self, script, args=None):
        """Run async JS; the injected final arg is `done(value)` — call it to resolve."""
        return self._wd("POST", f"/session/{self.sid}/execute/async",
                        {"script": script, "args": args or []})["value"]

    def json_js(self, script, args=None):
        """Convenience: js() where the script returns a JSON string -> dict."""
        return json.loads(self.js(script, args))

    def window(self, width, height, x=0, y=0):
        self._wd("POST", f"/session/{self.sid}/window/rect",
                 {"width": width, "height": height, "x": x, "y": y})
        time.sleep(0.3)

    def clear_cookies(self):
        """Delete all cookies for the current origin. Use before a jonson fetch
        run to bust the per-session answer cache — otherwise re-asking a question
        hits the 'you already asked that' repeat-nudge path and returns no panels.
        Re-navigate afterwards to pick up a fresh CSRF token + session."""
        self._wd("DELETE", f"/session/{self.sid}/cookie")

    def shot(self, path):
        """Screenshot to PNG. NOTE: settles the frame — see module docstring."""
        r = self._wd("GET", f"/session/{self.sid}/screenshot")
        open(path, "wb").write(base64.b64decode(r["value"]))
        return path

    # ---- measurement (the reliable path for visual bugs) -----------------
    def rect(self, selector):
        """getBoundingClientRect of the first match, as a dict (or None)."""
        return self.json_js(
            "var e=document.querySelector(arguments[0]);"
            "return e?JSON.stringify(e.getBoundingClientRect().toJSON()):'null';",
            [selector])

    def measure_top(self, selector, frames=100):
        """
        Sample element.top over `frames` rAF ticks and return the spread.
        range > ~0.5px while an animation runs nearby = real layout jitter.
        Returns {frames, min, max, range} or None if the selector misses.
        """
        return self.json_js(r"""
          var done = false;
          var sel = arguments[0], want = arguments[1];
          var el = document.querySelector(sel);
          if(!el){ return 'null'; }
          // NOTE: sync execute can't await rAF; callers wanting true multi-frame
          // sampling should use sample_top() (async). This returns a single read.
          var r = el.getBoundingClientRect();
          return JSON.stringify({frames:1, min:+r.top.toFixed(3), max:+r.top.toFixed(3), range:0});
        """, [selector, frames])

    def sample_top(self, selector, frames=100):
        """Async multi-frame version of measure_top — the real jitter probe."""
        return self.json_js_async(r"""
          var done = arguments[arguments.length-1];
          var el = document.querySelector(arguments[0]);
          if(!el){ done('null'); return; }
          var tops=[], n=0, N=arguments[1];
          (function tick(){
            tops.push(el.getBoundingClientRect().top);
            if(++n<N) requestAnimationFrame(tick);
            else { var mn=Math.min.apply(null,tops), mx=Math.max.apply(null,tops);
              done(JSON.stringify({frames:n, min:+mn.toFixed(3),
                max:+mx.toFixed(3), range:+(mx-mn).toFixed(3)})); }
          })();
        """, [selector, frames])

    def json_js_async(self, script, args=None):
        return json.loads(self.js_async(script, args))
