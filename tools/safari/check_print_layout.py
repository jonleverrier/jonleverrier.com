#!/usr/bin/env python3
"""
Print-layout probe for Safari.

Safari has no WebDriver media emulation, so this lifts every rule out of the
compiled sheet's `@media print` block and re-injects it WITHOUT the wrapper.
The page then lays out on screen under the print rules, at whatever window
width you ask for — which is the point: a print page box is not the width you
think, and it differs between engines.

It exists because of a bug Chrome could not show. The prose measure is
`max-width: 740px; margin-inline: auto`, so it only decentres once its
container is wider than 740 — and a Chrome print box is 673, so Chrome printed
it flush and aligned. Safari's is wider, so the text centred while the figures
either side of it did not, and every paragraph printed indented under a
full-width image. Sweeping the width here made it obvious in one line of
output.

Run `safaridriver -p 9223` first (see safari.py for the one-time setup), then:
    python3 check_print_layout.py

INDENT is the gap between a figure's left edge and the prose's. It should be 0
at every width.
"""
from safari import Safari
import time, json

UNWRAP = r"""
var out=[];
for (var i=0;i<document.styleSheets.length;i++){
  var ss=document.styleSheets[i]; var rules;
  try{rules=ss.cssRules;}catch(e){continue;}
  if(!rules) continue;
  for (var j=0;j<rules.length;j++){
    var r=rules[j];
    if(r.type===4 && r.media && r.media.mediaText.indexOf('print')!==-1){
      for(var k=0;k<r.cssRules.length;k++) out.push(r.cssRules[k].cssText);
    }
  }
}
var st=document.createElement('style'); st.id='__pp'; st.textContent=out.join('\n');
document.head.appendChild(st); return out.length;
"""

M = r"""
function b(s){var e=document.querySelector(s); if(!e) return null; var r=e.getBoundingClientRect();
 var cs=getComputedStyle(e);
 return {x:Math.round(r.left), right:Math.round(r.right), w:Math.round(r.width), maxw:cs.maxWidth, ml:cs.marginLeft};}
return JSON.stringify({vw:window.innerWidth, content:b('.c-content'), figure:b('.c-case-content__figure'),
 text:b('.c-case-content__text'), title:b('.c-content__title'), summary:b('.c-content__summary')});
"""

sf = Safari()
for w in (800, 1000, 1200):
    sf.set_window(w, 900) if hasattr(sf,'set_window') else sf.js("window.resizeTo(%d,900)"%w)
    sf.nav("https://jonleverrier2.local/about")
    time.sleep(3.5)
    sf.js(UNWRAP)
    time.sleep(1.0)
    d=json.loads(sf.js(M))
    f,t = d['figure'], d['text']
    print(f"vw={d['vw']:5} content w={d['content']['w']:5} | figure x={f['x']:4} w={f['w']:4} | text x={t['x']:4} w={t['w']:4} maxw={t['maxw']:8} | INDENT={t['x']-f['x']}")
