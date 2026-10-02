/**
 * Showboard slider cost: loads 18 large screenshots at Repeat x10 into the local tool,
 * sweeps every slider min-max, and prints the main-thread work per frame (median and
 * worst) — work, not frame gaps, since headless Chrome locks frames to its own rate.
 *
 *   node tools/showboard/sliders.mjs
 */
import puppeteer from 'puppeteer';
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 280000);
const b = await puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', acceptInsecureCerts: true, args: ['--ignore-certificate-errors', '--enable-gpu', '--use-angle=metal']});
const p = await b.newPage();
await p.evaluateOnNewDocument(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__work = [];
  window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); cb(t); window.__work.push(performance.now() - s); });
});
await p.setViewport({width: 1400, height: 900});
await p.goto('https://jonleverrier2.local/tools/showboard', {waitUntil: 'networkidle0'});
const r = await p.evaluate(async () => {
  const files = [];
  for (let i = 0; i < 18; i++) {
    const c = document.createElement('canvas'); c.width = 2880; c.height = 1800;
    const x = c.getContext('2d'); x.fillStyle = `hsl(${i*20},60%,45%)`; x.fillRect(0,0,c.width,c.height);
    files.push(new File([await new Promise(r => c.toBlob(r, 'image/png'))], `shot-${i}.png`, {type: 'image/png'}));
  }
  const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
  window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
  await new Promise(r => { const iv = setInterval(() => { if (document.getElementById('sb-count').textContent === '18 loaded') { clearInterval(iv); r(); } }, 20); });
  const frames = (n) => new Promise(r => { const go = (k) => k ? requestAnimationFrame(() => go(k - 1)) : r(); go(n); });
  const set = (id, v) => { const el = document.getElementById('sb-' + id); el.value = v; el.dispatchEvent(new Event('input', {bubbles: true})); };
  set('repeat', 10); await frames(4);
  const out = {};
  for (const key of ['cols','repeat','gap','depth','stagger','tilt','spin','radius','shadow','yaw','pitch','fov','zoom']) {
    const el = document.getElementById('sb-' + key); if (!el) continue;
    const min = +el.min, max = +el.max, orig = el.value;
    const per = [];
    for (let k = 0; k <= 16; k++) {
      window.__work = [];
      set(key, min + (max - min) * (k % 2 ? k / 16 : (16 - k) / 16));
      await frames(2);
      per.push(Math.max(0, ...window.__work));
    }
    set(key, orig); if (key === 'repeat') set('repeat', 10); await frames(2);
    per.sort((a, b) => a - b);
    out[key] = {median: +per[8].toFixed(1), worst: +per[16].toFixed(1)};
  }
  return out;
});
for (const [k, v] of Object.entries(r)) console.log(k.padEnd(8), 'median', String(v.median).padStart(6), 'ms   worst', String(v.worst).padStart(6), 'ms');
await b.close(); process.exit(0);
