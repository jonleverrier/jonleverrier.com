#!/usr/bin/env python3
"""Report every text left-edge that disagrees with the page's left margin,
in Safari, under the print rules, at a wide page box."""
from safari import Safari
import time, json, sys

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

AUDIT = r"""
var base = null;
var t = document.querySelector('.c-content__title');
if (t) base = Math.round(t.getBoundingClientRect().left);
var rows=[];
var all=document.querySelectorAll('body *');
for (var i=0;i<all.length;i++){
  var e=all[i];
  var r=e.getBoundingClientRect();
  if (r.height<10 || r.width<40) continue;
  var direct=false;
  for (var n=0;n<e.childNodes.length;n++){
    if (e.childNodes[n].nodeType===3 && e.childNodes[n].textContent.trim()) { direct=true; break; }
  }
  if(!direct) continue;
  var rg=document.createRange(); rg.selectNodeContents(e);
  var x=Math.round(rg.getBoundingClientRect().left);
  if (Math.abs(x-base) <= 2) continue;
  rows.push({cls:(e.className||e.tagName).toString().slice(0,44), x:x, d:x-base, txt:e.textContent.trim().slice(0,24)});
}
return JSON.stringify({base:base, rows:rows.slice(0,30)});
"""

url = sys.argv[1] if len(sys.argv)>1 else "https://jonleverrier2.local/about"
sf = Safari()
sf.js("window.resizeTo(1200,900)")
sf.nav(url)
time.sleep(4)
sf.js(UNWRAP)
time.sleep(1.2)
d = json.loads(sf.js(AUDIT))
print("page left edge (title):", d["base"])
seen=set()
for r in d["rows"]:
    k=(r["cls"], r["d"])
    if k in seen: continue
    seen.add(k)
    print(f"  {r['d']:+5}  x={r['x']:5}  {r['cls']:<44} {r['txt']!r}")
