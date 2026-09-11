#!/usr/bin/env python3
"""
Build a real jonson response stack inside Safari for visual testing.

This is the site-specific companion to safari.py. It hits the live /jonson/ask
SSE endpoint (same origin, real markers) to pull genuine component HTML —
method, clients marquee, testimonial, music, etc. — then injects a chosen stack
into the thread and wires up the bits JS normally would (marquee cloning +
duration, active testimonial slide, active method phase + fill).

Use it to reproduce a specific stack that triggers a Safari-only bug, e.g.
"clients marquee + testimonial ABOVE the method" (the c-method jitter repro),
without typing questions and waiting for the funnel to surface each panel.

    from safari import Safari
    from jonson_stack import fetch_component, inject_stack

    sf = Safari()
    sf.nav(SITE)
    method   = fetch_component(sf, "What is your process for a project?", "method")
    clients  = fetch_component(sf, "Which brands have you worked with?", "clients")
    testi    = fetch_component(sf, "Show me client testimonials.", "testimonial")
    inject_stack(sf, [testi, clients, method])   # top -> bottom order
    sf.shot("stack.png")

Each fetched value is raw component HTML (or None if that marker didn't fire —
retry with a differently-worded question, or check the funnel stage).
"""
import json

SITE = "https://jonleverrier2.local.ddev.site/"


def fetch_component(sf, question, event, continuation="0", tries=4, fresh=True):
    """Ask a question and return the HTML carried by the given SSE `event`
    (e.g. 'method', 'clients', 'testimonial', 'music', 'contact'), or None.

    Panels only stream on a *first* message (continuation "0") in a *fresh*
    session — re-asking within a session hits the repeat-nudge path and returns
    no panels. So each fetch defaults to fresh=True (clear cookies + re-nav)
    and continuation "0", making every call an independent, reliable one-shot.
    Set fresh=False to fetch several panels from one ongoing conversation."""
    if fresh:
        sf.clear_cookies()
        sf.nav(SITE)
    return sf.js_async(r"""
      var done = arguments[arguments.length-1];
      var q = arguments[0], cont = arguments[1], ev = arguments[2], tries = arguments[3];
      (async function(){
        var csrf = document.querySelector('input[name="CRAFT_CSRF_TOKEN"]');
        csrf = csrf ? csrf.value : '';
        async function ask(){
          var r = await fetch('/jonson/ask', {method:'POST', headers:{
            'Accept':'text/event-stream',
            'Content-Type':'application/x-www-form-urlencoded',
            'X-Requested-With':'XMLHttpRequest','X-CSRF-Token':csrf},
            body:new URLSearchParams({question:q, continuation:cont}).toString()});
          var t = await r.text();
          var m = t.match(new RegExp('event: '+ev+'\\ndata: (.*)'));
          return m ? JSON.parse(m[1]).html : null;
        }
        for(var i=0;i<tries;i++){ var h=await ask(); if(h){ done(h); return; } }
        done(null);
      })();
    """, [question, continuation, event, tries])


def inject_stack(sf, components, answer="Answer paragraph at the measure so the stack matches production."):
    """
    Replace the jonson thread with a single revealed response containing the
    given components (top-to-bottom), then wire up marquee / testimonial /
    method the way jonson-ask.js does on reveal. Skips None entries.
    Returns a dict summarising what got activated.
    """
    html = "".join(c for c in components if c)
    return sf.json_js(r"""
      var answer = arguments[0], inner = arguments[1];
      document.documentElement.classList.add('is-conversing','is-jonson');
      var tun = document.querySelector('[data-tunnel]'); if(tun) tun.hidden = true;
      var view = document.querySelector('[data-jonson-view]'); if(view) view.hidden = false;
      var thread = document.querySelector('[data-jonson-thread]');
      thread.innerHTML = '<div class="c-jonson__turn"><div class="c-jonson__response is-revealed">'
        + '<p>'+answer+'</p>' + inner + '</div></div>';

      // clients marquee: clone until it overflows, duplicate the run, set duration
      var marquee = thread.querySelector('.c-clients');
      if(marquee){
        var track=marquee.querySelector('.c-clients__track');
        var run=track.querySelector('.c-clients__items');
        var logos=[].slice.call(run.children), g=0;
        while(run.scrollWidth<marquee.clientWidth && g<50){
          logos.forEach(function(l){run.appendChild(l.cloneNode(true));}); g++; }
        track.appendChild(run.cloneNode(true));
        marquee.style.setProperty('--c-clients-duration', Math.max(8, run.scrollWidth/20)+'s');
        marquee.classList.add('is-ready');
      }
      // testimonial: first slide active
      var slis = thread.querySelectorAll('.c-testimonials.has-multiple');
      for(var i=0;i<slis.length;i++){
        var s=slis[i].querySelectorAll('.c-testimonial');
        for(var j=0;j<s.length;j++) s[j].classList.toggle('is-active', j===0);
      }
      // method: activate phase 0, set the fill width, leave ping to fire
      var m = thread.querySelector('.c-method');
      if(m){
        var ph=m.querySelector('.c-method__phase'); ph.classList.add('is-active');
        var nd=ph.querySelector('.c-method__node');
        var fl=m.querySelector('.c-method__line--fill');
        if(fl&&nd) fl.style.width = (ph.offsetLeft + nd.offsetWidth/2)+'px';
      }
      return JSON.stringify({marquee:!!marquee, testimonials:slis.length, method:!!m});
    """, [answer, html])
