/**
 * CONSOLE
 *
 * A hello for whoever opens devtools — the people most likely to hire a design
 * engineer. A styled banner, then something to try:
 *
 *   jonson.ask('What are you working on?')   ask the site's assistant, answered right here
 *
 * Loaded lazily from app.js once the page is idle, so it costs a first visit nothing.
 * There is no reliable way to know devtools has opened, and no need: anything logged
 * at load is waiting there whenever someone looks.
 *
 * jonson.ask() is the same endpoint the page uses (/jonson/ask), so the same rate
 * limit and the same answer — with its own conversation id, so a console chat never
 * bleeds into the thread on the page (or the other way round). The CSRF token comes
 * from Craft's session-info action, because only the homepage has a form carrying
 * one; every other page's ask bar is a plain hand-off to the homepage.
 */

const RED = '#e02e1a';
// The roundel from _includes/page/logo.twig (white disc, navy mark) — the console
// takes an image only as a CSS background, so it goes in as a data URL. Keep in step
// with the template if the mark ever changes.
const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32.1016 63.4021C49.4986 63.4021 63.6016 49.2991 63.6016 31.9021C63.6016 14.5051 49.4986 0.4021 32.1016 0.4021C14.7046 0.4021 0.601562 14.5051 0.601562 31.9021C0.601562 49.2991 14.7046 63.4021 32.1016 63.4021Z" fill="#FFFFFF"/><path d="M38.7013 38.8021V27.4021C38.4013 24.0021 35.7019 21.4021 32.3019 21.3021C28.9019 21.4021 26.1021 24.1021 26.0021 27.5021V40.1021C26.1021 45.2021 21.9019 49.4021 16.8019 49.5021C11.7019 49.6021 7.5015 45.4021 7.4015 40.3021C7.4015 40.2021 7.4015 40.2021 7.4015 40.1021C7.4015 38.5021 8.70189 37.2021 10.3019 37.1021C11.9019 37.1021 13.2013 38.4021 13.2013 40.1021C13.2013 41.9021 14.6021 43.5021 16.5021 43.5021H16.6017C18.3017 43.5021 19.7021 42.3021 20.0021 40.6021V27.7021C20.0021 27.2021 20.0017 26.8021 20.1017 26.3021C20.8017 19.5021 26.8021 14.6021 33.5021 15.3021C39.7021 15.9021 44.5017 21.1021 44.6017 27.3021C44.6017 27.7021 44.7013 28.1021 44.7013 28.6021V39.1021C44.7013 40.9221 46.1816 42.4021 48.0016 42.4021H62.3019C63.4019 39.1021 64.0021 35.7021 64.0021 32.3021C64.2021 14.6021 50.0019 0.202087 32.3019 0.002087C14.6019 -0.197913 0.202088 14.0021 0.00208711 31.7021C-0.197912 49.4021 14.0013 63.8021 31.7013 64.0021C43.2013 64.1021 53.9013 58.0021 59.7013 48.1021H48.0016C42.8616 48.1021 38.7013 43.9421 38.7013 38.8021ZM32.3019 38.1021C30.5019 38.1021 29.0021 36.6021 29.0021 34.8021C29.0021 33.0021 30.5019 31.5021 32.3019 31.5021C34.1019 31.5021 35.6017 33.0021 35.6017 34.8021C35.6017 36.7021 34.1019 38.1021 32.3019 38.1021Z" fill="#162C41"/></svg>')}`;
// The site's webfont doesn't reach devtools, so say so plainly rather than name it.
const FONT = 'system-ui, -apple-system, sans-serif';

let csrf = null;   // {name, value}, fetched once
let turns = 0;     // console questions asked this page; the first is an opener
let busy = false;

export function mountConsole() {
    if (window.jonson) return; // never twice, never over something else's
    banner();
    window.jonson = {ask};
}

function banner() {
    // HEIGHT FROM line-height, NOT padding. Safari's console doesn't grow the row for
    // vertical padding, so a padded box spilled over the next message; a line-height
    // on the 1px-font span makes the row itself 64px tall in Chrome and Safari alike.
    //
    // NOT IN SAFARI: its console honours the row's size but never draws a background
    // image, so the logo came out as an empty 64px gap above the name. Chrome, Edge
    // and Firefox draw it. Desktop Safari is the only "Safari" UA without Chrome,
    // Chromium, CriOS, FxiOS or Edg in it.
    if (!/^((?!chrome|chromium|crios|fxios|edg).)*safari/i.test(navigator.userAgent)) {
        console.log(
            '%c ',
            `font-size: 1px; line-height: 64px; padding: 0 32px; background: url("${LOGO}") center / 64px 64px no-repeat;`,
        );
    }
    console.log(
        `%cJon Leverrier\n%cHello, fellow dev 👋 Meet Jonson, my AI assistant.`,
        `font: 700 18px ${FONT};`,
        `font: 16px/1.5 ${FONT};`,
    );
    console.log(
        `%cAsk it anything:%c  jonson.ask('What are you working on?')`,
        `font: 13px ${FONT};`,
        `font: 600 13px monospace; color: ${RED};`,
    );
    console.log(`%cAre you hiring? ${location.origin}/contact`, `font: 13px ${FONT};`);
}

// Sync, and RETURNS its status line rather than logging it. The console prints
// whatever an expression returns: logging "Thinking…" and returning nothing showed
// it AND an `undefined` under every question, and an async function would print
// `Promise {<pending>}`. The answer itself is logged when it lands.
function ask(question) {
    if (typeof question !== 'string' || !question.trim()) {
        return "Ask Jonson a question, as a string:  jonson.ask('What are you working on?')";
    }
    if (busy) {
        return 'Jonson is still answering the last one — give it a moment.';
    }
    run(question.trim());
    return '🤔 Thinking…';
}

async function run(question) {
    busy = true;
    try {
        const token = await csrfToken();
        const body = new URLSearchParams({
            question,
            continuation: turns > 0 ? '1' : '0',
            cid: storedId('jonson.console.cid', localStorage),
            sid: storedId('jonson.sid', sessionStorage), // the page's visit id, shared
            pageUrl: location.pathname,
        });
        if (token) body.set(token.name, token.value);

        const res = await fetch(`${location.origin}/jonson/ask`, {
            method: 'POST',
            headers: {
                'Accept': 'text/event-stream',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: body.toString(),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const {answer, suggestions, error} = await readStream(res.body);
        turns++;
        if (error) {
            console.log(`%c${error}`, `font: 13px/1.5 ${FONT};`);
        } else if (answer) {
            console.log(`%cJonson%c\n${plain(answer)}`, `font: 700 13px ${FONT}; color: ${RED};`, `font: 14px/1.6 ${FONT};`);
        }
        if (suggestions.length) {
            console.log(
                `%cTry next:%c\n${suggestions.map((q) => `jonson.ask(${JSON.stringify(q)})`).join('\n')}`,
                `font: 12px ${FONT}; color: #888;`,
                'font: 12px monospace;',
            );
        }
    } catch (e) {
        console.log(`%cJonson couldn't be reached just now (${e.message}). Try again in a moment.`, `font: 13px ${FONT};`);
    } finally {
        busy = false;
    }
}

// The same SSE stream the page reads. Only the finished answer matters here — `answer`
// arrives first on a live turn, `done` carries it on every path (replays, the junk gate,
// API errors) — plus the chips, offered back as more jonson.ask() calls.
async function readStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let suggestions = [];
    let error = '';
    for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = (block.match(/^event: (.*)$/m) || [])[1];
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
            if (!event || !data) continue;
            const json = JSON.parse(data);
            if ((event === 'answer' || event === 'done') && typeof json.answer === 'string' && json.answer) {
                answer = json.answer;
            } else if (event === 'suggestions') {
                suggestions = json.items || [];
            } else if (event === 'error') {
                error = json.message || '';
            }
        }
    }
    return {answer, suggestions, error};
}

// The answer as console text: markers out, links as "words (full url)", emphasis off.
function plain(text) {
    return text
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, words, href) => `${words} (${new URL(href, location.origin).href})`)
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function csrfToken() {
    if (csrf) return csrf;
    const res = await fetch(`${location.origin}/actions/users/session-info`, {headers: {Accept: 'application/json'}});
    const info = await res.json();
    csrf = info.csrfTokenName ? {name: info.csrfTokenName, value: info.csrfTokenValue} : null;
    return csrf;
}

function storedId(key, store) {
    try {
        let id = store.getItem(key);
        if (!id) {
            id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            store.setItem(key, id);
        }
        return id;
    } catch (e) {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}
