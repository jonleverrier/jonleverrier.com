/**
 * Unit test for inlineMarkdown() in build/js/components/jonson-ask.js.
 *
 * The link allowlist is the reason this file exists. That function renders text a
 * MODEL wrote, straight into innerHTML, and thread-memory.js then stores the result
 * and puts it back on the next page — so an attribute that gets through here outlives
 * the answer that carried it. Every "should NOT become a link" case below is a way in
 * that was considered and closed; deleting one is deleting the reason it is closed.
 *
 * The real function is lifted out of the module rather than imported, because the
 * module touches the DOM at load. `document` is passed in as a parameter, which is
 * also how the two allowlist states are set up: the page's data-jonson-links is read
 * once and cached, so each scenario gets its own instance of the function.
 *
 *   node tools/jonson/inline-markdown.test.mjs
 */
import {readFileSync} from 'node:fs';

const src = readFileSync('build/js/components/jonson-ask.js', 'utf8');
const start = src.indexOf('const LINK_ALLOWED');
const end = src.indexOf('\n}\n', src.indexOf('function inlineMarkdown')) + 3;
const mod = src.slice(start, end);

/** An inlineMarkdown bound to a page carrying `links` in data-jonson-links. */
function renderer(links) {
    const fakeDocument = {
        querySelector: () => (links === null ? null : {dataset: {jonsonLinks: links}}),
    };
    return new Function('document', mod + '\nreturn inlineMarkdown;')(fakeDocument);
}

const WHATSAPP = 'https://wa.me/+33668430934';
const withCtas = renderer(`tel:+33668430934 ${WHATSAPP}`);
const noCtas = renderer(null); // an ordinary visitor — no door, no data attribute

let pass = 0;
let fail = 0;
const t = (name, fn, input, expected) => {
    const got = fn(input);
    const ok = got === expected;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        in:   ${input}\n        got:  ${got}\n        want: ${expected}`);
};
const a = (href, label) => `<a class="c-jonson__link" href="${href}">${label}</a>`;

console.log('--- allowed by shape: tel, mailto, same-site ---');
t('tel', withCtas, '[+33668430934](tel:+33668430934)', a('tel:+33668430934', '+33668430934'));
t('mailto', withCtas, 'Write to [me](mailto:hello@leverrier.co.uk).', `Write to ${a('mailto:hello@leverrier.co.uk', 'me')}.`);
t('site path', withCtas, 'See [my work](/work).', `See ${a('/work', 'my work')}.`);
t('bold inside label', withCtas, '[**call**](tel:123)', a('tel:123', '<strong>call</strong>'));
t('tel works with no door', noCtas, '[call](tel:123)', a('tel:123', 'call'));

console.log('\n--- external https: only by exact match on the page list ---');
t('whatsapp, on the list', withCtas, 'or [send me a WhatsApp](https://wa.me/+33668430934)',
    `or ${a('https://wa.me/+33668430934', 'send me a WhatsApp')}`);
t('same host, different path', withCtas, '[x](https://wa.me/+44000000000)', '[x](https://wa.me/+44000000000)');
t('plausible but invented', withCtas, '[my calendar](https://calendly.com/jonleverrier/chat)', '[my calendar](https://calendly.com/jonleverrier/chat)');
t('on the list but no door', noCtas, `[whatsapp](${WHATSAPP})`, `[whatsapp](${WHATSAPP})`);

console.log('\n--- refused outright (left as the model typed them) ---');
t('javascript:', withCtas, '[x](javascript:alert(1))', '[x](javascript:alert(1))');
t('data:', withCtas, '[x](data:text/html;base64,PHM+)', '[x](data:text/html;base64,PHM+)');
t('protocol-relative', withCtas, '[x](//evil.example)', '[x](//evil.example)');
t('attribute break-out', withCtas, '[x](tel:1"onmouseover="alert(1))', '[x](tel:1"onmouseover="alert(1))');
t('uppercase JS scheme', withCtas, '[x](JaVaScRiPt:alert(1))', '[x](JaVaScRiPt:alert(1))');
t('tab in scheme', withCtas, '[x](java\tscript:alert(1))', '[x](java\tscript:alert(1))');
t('http, not https', withCtas, '[x](http://wa.me/+33668430934)', '[x](http://wa.me/+33668430934)');

console.log('\n--- unchanged behaviour ---');
t('bold', withCtas, 'a **b** c', 'a <strong>b</strong> c');
t('italic', withCtas, 'a *b* c', 'a <em>b</em> c');
t('html escaped', withCtas, '<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;');
t('plain text', withCtas, 'no markup here', 'no markup here');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
