// Syntax highlighting for the code blocks a rich-content matrix can carry — see
// _components/code-block.twig for the markup.
//
// The served page is the WORKING one: a <pre><code> with the source in it, styled
// as a code panel by _code.scss, readable with no JS at all. This module only
// COLOURS it. The highlighter (Shiki: grammars, a theme, a regex engine) is a
// separate chunk fetched when a block comes within a viewport of the screen, so
// pages without code never load it and pages with it load it late. Highlighting
// swaps the <code>'s children for Shiki's coloured spans — same text, same
// whitespace, so nothing moves.
//
// A language the highlighter doesn't know is left as it is. Better a plain block
// than a broken one.

const SEL = 'pre[data-code]';
const PREFETCH_MARGIN = '100% 0px';

// How long "Copied" shows before the button goes back to being a button.
const COPIED_MS = 2000;

// Two icons, both in the button: the clipboard at rest, the tick while it says
// "Copied". CSS shows one and hides the other by the button's state, so a press
// swaps them without the markup changing.
const ICONS = '<svg class="c-code__copy-icon c-code__copy-icon--copy" viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">'
    + '<path fill-rule="evenodd" clip-rule="evenodd" d="M13.887 3.182c.396.037.79.08 1.183.128C16.194 3.45 17 4.414 17 5.517V16.75A2.25 2.25 0 0 1 14.75 19h-9.5A2.25 2.25 0 0 1 3 16.75V5.517c0-1.103.806-2.068 1.93-2.207.393-.048.787-.09 1.183-.128A3.001 3.001 0 0 1 9 1h2c1.373 0 2.531.923 2.887 2.182ZM7.5 4A1.5 1.5 0 0 1 9 2.5h2A1.5 1.5 0 0 1 12.5 4v.5h-5V4Z"/>'
    + '</svg>'
    + '<svg class="c-code__copy-icon c-code__copy-icon--done" viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">'
    + '<path fill-rule="evenodd" clip-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"/>'
    + '</svg>';

// The panel's corner control: the language name and the copy icon in one box,
// and the whole box is the copy button — the name is the biggest target, so it
// copies too. Added by JS, not the template: with no JS there's nothing to copy
// WITH, so the template's plain label (the pre's ::before) stays up instead and
// steps down once this is in place. Reads the <code>'s text — the line numbers
// are CSS and never part of it — and the name reads "Copied" for a moment.
function addCopy(pre) {
    if (pre.querySelector('.c-code__copy') || !navigator.clipboard) return;
    const code = pre.querySelector('code');
    if (!code) return;

    const name = pre.dataset.codeLabel || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'c-code__copy';
    button.setAttribute('aria-label', name ? `Copy ${name} code` : 'Copy code');
    button.innerHTML = (name ? `<span class="c-code__copy-label">${name}</span>` : '') + ICONS;
    const label = button.querySelector('.c-code__copy-label');

    let reset = null;
    button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(code.textContent);
        } catch {
            return; // permission refused — leave the button as it was
        }
        button.classList.add('is-copied');
        if (label) label.textContent = 'Copied';
        button.setAttribute('aria-label', 'Copied');
        clearTimeout(reset);
        reset = setTimeout(() => {
            button.classList.remove('is-copied');
            if (label) label.textContent = name;
            button.setAttribute('aria-label', name ? `Copy ${name} code` : 'Copy code');
        }, COPIED_MS);
    });

    pre.append(button);
}

let lib = null;
const loadLib = () => {
    lib ??= import('./code-highlighter.js');
    return lib;
};

async function highlight(pre) {
    if (pre._highlighting) return;
    pre._highlighting = true;

    const code = pre.querySelector('code');
    if (!code) return;

    let mod;
    try {
        mod = await loadLib();
    } catch {
        return; // the chunk didn't arrive — the plain block stays
    }

    const lang = mod.LANGS[(pre.dataset.codeLang || '').toLowerCase()];
    if (!lang) return;

    let hl, out;
    try {
        hl = await mod.getHighlighter(lang);
        if (!pre.isConnected) return;
        // Shiki hands back its own <pre><code>; only the coloured lines are wanted —
        // the panel, its background and its padding are ours (see _code.scss).
        out = hl.codeToHtml(code.textContent, {lang, theme: mod.THEME});
    } catch (err) {
        // A grammar that failed to load or to run — the plain block stays, and
        // the reason is in the console rather than swallowed.
        console.warn('code-block: could not highlight', lang, err);
        return;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = out;
    const inner = tpl.content.querySelector('code');
    if (!inner) return;

    code.innerHTML = inner.innerHTML;
    pre.classList.add('is-highlighted');
}

/** Wire every code block inside `root`. Idempotent. */
export function mountCodeBlocks(root = document) {
    if (!root) return () => {};
    const scope = root === document ? document : root;
    const blocks = [...scope.querySelectorAll(SEL)];
    if (!blocks.length) return () => {};

    blocks.forEach(addCopy);

    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            highlight(e.target);
        }
    }, {rootMargin: PREFETCH_MARGIN});
    blocks.forEach((b) => io.observe(b));

    return () => io.disconnect();
}
