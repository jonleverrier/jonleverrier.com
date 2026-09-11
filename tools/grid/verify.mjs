// Behavioural checks for jonson-grid: fill accounting, hover warp, home-page mount.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import puppeteer from 'puppeteer';
const OUT = process.argv[2] ?? '.';
const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--ignore-certificate-errors', '--window-size=1728,1000'],
    defaultViewport: null,
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
    window.__stats = { pathFills: 0, plainFills: 0, canvases: new Set() };
    const orig = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (...a) {
        window.__stats.canvases.add(this.canvas.className || this.canvas.id || 'anon');
        if (a[0] instanceof Path2D) window.__stats.pathFills++; else window.__stats.plainFills++;
        return orig.apply(this, a);
    };
});
const frames = (n) => page.evaluate((n) => new Promise(res => { let k = 0; const f = () => (++k < n ? requestAnimationFrame(f) : res()); requestAnimationFrame(f); }), n);
const stats = () => page.evaluate(() => ({ pathFills: window.__stats.pathFills, plainFills: window.__stats.plainFills, canvases: [...window.__stats.canvases] }));

await page.goto('https://jonleverrier2.local/case-study/vaiie-product-branding', { waitUntil: 'networkidle0' });
await page.evaluate(() => window.scrollTo(0, 2500));
await new Promise(r => setTimeout(r, 800));
let s0 = await stats(); await frames(60); let s1 = await stats();
console.log('scrolled, no pointer:', { pathFills: (s1.pathFills - s0.pathFills) / 60, plainFills: (s1.plainFills - s0.plainFills) / 60, canvases: s1.canvases });
await page.screenshot({ path: `${OUT}/scrolled-nopointer.png`, clip: { x: 200, y: 100, width: 500, height: 400 } });

await page.mouse.move(450, 300); await new Promise(r => setTimeout(r, 400));
s0 = await stats(); await frames(60); s1 = await stats();
console.log('scrolled, hover:', { pathFills: (s1.pathFills - s0.pathFills) / 60, plainFills: (s1.plainFills - s0.plainFills) / 60 });
await page.screenshot({ path: `${OUT}/scrolled-hover.png`, clip: { x: 200, y: 100, width: 500, height: 400 } });
// displacement actually applied?
const warped = await page.evaluate(() => {
    const c = document.querySelector('canvas.c-jonson__grid');
    return { transform: c.style.transform, h: c.style.height };
});
console.log('canvas:', warped);

// Home: the .c-jonson view is hidden until a question is asked.
await page.goto('https://jonleverrier2.local/', { waitUntil: 'networkidle0' });
const before = await page.evaluate(() => { const v = document.querySelector('[data-jonson-view]'); return { hidden: v.hidden, hasCanvas: !!v.querySelector('canvas'), interactive: v.classList.contains('is-interactive') }; });
console.log('home before ask:', before);
await page.type('[data-jonson-form] input[type="text"]', 'Who are you?');
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 6000));
const after = await page.evaluate(() => { const v = document.querySelector('[data-jonson-view]'); const c = v.querySelector('canvas'); return { hidden: v.hidden, interactive: v.classList.contains('is-interactive'), bitmap: c && [c.width, c.height], cssH: c && c.style.height, viewH: Math.round(v.getBoundingClientRect().height), transform: c && c.style.transform }; });
console.log('home after ask:', after);
await page.screenshot({ path: `${OUT}/home-thread.png` });
await browser.close();
