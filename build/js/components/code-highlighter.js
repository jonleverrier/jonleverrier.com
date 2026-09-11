// The Shiki highlighter — the HEAVY part, kept in its own module so code-block.js
// can pull it in on demand. Never import this statically: only pages with a code
// block should pay for it.
//
// Fine-grained build, not the bundled one: the core, the JavaScript regex engine
// (no WebAssembly to fetch) and one theme come first, as one chunk. Each
// GRAMMAR is fetched the first time a block asks for that language.
//
// Grammars come from tm-grammars' raw JSON, composed here, NOT from
// @shikijs/langs. The @shikijs/langs modules are the same grammars with every
// grammar they embed imported statically, recursively and generously — Twig's
// brings Python and Ruby (via PHP, Java and SQL): 46 grammars, 1.6MB, for a
// template language. The snippets here are web code, so each language is
// composed from exactly the grammars it can embed on this site (EMBEDS below).
// An `include` of a grammar that isn't loaded is simply never matched — a
// `{% raw %}` block of Ruby renders plain rather than breaking anything.
//
// Adding a language: one entry in LANGS, one in EMBEDS, one in GRAMMARS.

import {createHighlighterCore} from 'shiki/core';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';
import theme from '@shikijs/themes/github-dark';

// What the CMS may say → the grammar Shiki knows. The dropdown's values are the
// keys here; anything else falls back to plain text (see code-block.js).
export const LANGS = {
    twig: 'twig',
    php: 'php',
    js: 'javascript',
    javascript: 'javascript',
    html: 'html',
    shell: 'shellscript',
    bash: 'shellscript',
    sh: 'shellscript',
    shellscript: 'shellscript',
    css: 'css',
    scss: 'scss',
};

export const THEME = 'github-dark';

// The raw grammar files. Vite turns each JSON import into its own chunk and
// shares one between the languages that need it (HTML, CSS and JavaScript
// serve Twig, PHP and HTML alike).
const GRAMMARS = {
    twig: () => import('tm-grammars/grammars/twig.json'),
    php: () => import('tm-grammars/grammars/php.json'),
    javascript: () => import('tm-grammars/grammars/javascript.json'),
    html: () => import('tm-grammars/grammars/html.json'),
    css: () => import('tm-grammars/grammars/css.json'),
    scss: () => import('tm-grammars/grammars/scss.json'),
    json: () => import('tm-grammars/grammars/json.json'),
    shellscript: () => import('tm-grammars/grammars/shellscript.json'),
};

// What each language may embed here. Declared to Shiki as `embeddedLangs`, so
// it loads them first and resolves the grammar's includes against them.
const EMBEDS = {
    twig: ['html', 'css', 'javascript'],
    php: ['html', 'css', 'javascript', 'json'],
    html: ['css', 'javascript'],
    css: [],
    scss: ['css'], // SCSS is a superset; its grammar leans on the CSS one for the plain parts
    javascript: [],
    json: [],
    shellscript: [],
};

// ONE highlighter, held as a promise: the first block on a page asks for it
// while the second and third are asking too, and holding the instance instead
// of the promise let each of them create its own — the grammars then landed in
// instances that were thrown away, and only the last block coloured.
let highlighterPromise = null;
const grammarPromises = new Map(); // grammar id → promise: fetched and loaded once

function core() {
    highlighterPromise ??= createHighlighterCore({
        langs: [],
        themes: [theme],
        engine: createJavaScriptRegexEngine(),
    });
    return highlighterPromise;
}

async function loadGrammar(id) {
    if (!GRAMMARS[id]) return;
    if (!grammarPromises.has(id)) {
        grammarPromises.set(id, (async () => {
            const embeds = EMBEDS[id] ?? [];
            await Promise.all(embeds.map(loadGrammar)); // dependencies first
            const [hl, mod] = await Promise.all([core(), GRAMMARS[id]()]);
            await hl.loadLanguage({...mod.default, name: id, embeddedLangs: embeds});
        })());
    }
    await grammarPromises.get(id);
}

export async function getHighlighter(lang) {
    const hl = await core();
    if (lang) await loadGrammar(lang);
    return hl;
}
