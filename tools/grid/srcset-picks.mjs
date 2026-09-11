process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import puppeteer from 'puppeteer';
const url = process.argv[2] ?? 'https://jonleverrier2.local/case-study/vaiie-product-branding';
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
const rows = [];
for (const vw of [390, 768, 1024, 1440, 1728, 1920]) {
    await page.setViewport({ width: vw, height: 900, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle0' });
    // force lazy images to resolve
    await page.evaluate(async () => { document.querySelectorAll('img').forEach(i => i.loading = 'eager'); window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1500)); });
    const r = await page.evaluate(() => [...document.querySelectorAll('.c-case-content__figure')].map(f => {
        const img = f.querySelector('img'); const src = f.querySelector('source');
        const m = (img.currentSrc || '').match(/[?&]width=(\d+)|_(\d+)x|-(\d+)\.|w(\d+)/);
        return { kind: f.parentElement.className.includes('pair') ? 'pair' : f.parentElement.className.includes('trio') || f.parentElement.className.includes('three') ? 'three' : 'single', figW: Math.round(f.getBoundingClientRect().width), sizes: src.sizes, picked: (img.currentSrc.match(/_(\d+)x[A-Za-z]*/) || [,'?'])[1], dpr: +((img.currentSrc.match(/_(\d+)x/) || [,0])[1] / f.getBoundingClientRect().width).toFixed(2) };
    }));
    // dedupe by kind
    const seen = new Set();
    for (const x of r) { if (seen.has(x.kind)) continue; seen.add(x.kind); rows.push({ vw, ...x }); }
}
console.table(rows.map(({ vw, kind, figW, picked, dpr }) => ({ vw, kind, figW, picked, dpr })));
await browser.close();
