// Idle frame cost + canvas stats for the jonson-grid canvas on a page.
//   node tools/grid/measure.mjs https://jonleverrier2.local/case-study/vaiie-product-branding [scrollY]
// Runs headed Chrome (rAF only fires in a visible tab) at a 1728 window.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import puppeteer from 'puppeteer';

const url = process.argv[2] ?? 'https://jonleverrier2.local/case-study/vaiie-product-branding';
const scrollY = Number(process.argv[3] ?? 0);

const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--ignore-certificate-errors', '--window-size=1728,1000', '--disable-features=TranslateUI'],
    defaultViewport: null,
});
const page = await browser.newPage();

// Count arc() calls per frame (both direct ctx.arc and Path2D.arc), and fill() calls.
await page.evaluateOnNewDocument(() => {
    window.__stats = { arcs: 0, fills: 0 };
    const wrap = (proto, name, key) => {
        const orig = proto[name];
        proto[name] = function (...a) { window.__stats[key]++; return orig.apply(this, a); };
    };
    wrap(CanvasRenderingContext2D.prototype, 'arc', 'arcs');
    wrap(CanvasRenderingContext2D.prototype, 'fill', 'fills');
    if (window.Path2D) wrap(Path2D.prototype, 'arc', 'arcs');
});

await page.goto(url, { waitUntil: 'networkidle0' });
if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
await new Promise(r => setTimeout(r, 1500));

const result = await page.evaluate(async () => {
    const c = document.querySelector('canvas.c-jonson__grid');
    const cont = c && c.parentElement;
    const info = c ? {
        bitmap: [c.width, c.height],
        megapixels: +(c.width * c.height / 1e6).toFixed(1),
        css: [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)],
        transform: c.style.transform,
        containerH: Math.round(cont.getBoundingClientRect().height),
        interactive: cont.classList.contains('is-interactive'),
    } : 'NO CANVAS';
    // per-frame draw stats over 60 frames
    const s0 = { ...window.__stats };
    await new Promise(res => { let n = 0; const f = () => (++n < 60 ? requestAnimationFrame(f) : res()); requestAnimationFrame(f); });
    const s1 = { ...window.__stats };
    const perFrame = { arcs: Math.round((s1.arcs - s0.arcs) / 60), fills: Math.round((s1.fills - s0.fills) / 60) };
    // idle rAF deltas over ~2s
    const deltas = [];
    await new Promise(res => { let last = performance.now(); let n = 0; const f = t => { deltas.push(t - last); last = t; if (++n < 120) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    deltas.sort((a, b) => a - b);
    const q = p => +deltas[Math.floor(deltas.length * p)].toFixed(1);
    return { info, perFrame, frameMs: { median: q(0.5), p90: q(0.9), max: +deltas[deltas.length - 1].toFixed(1) } };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
