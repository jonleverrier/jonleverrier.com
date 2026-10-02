<?php
/**
 * Routes — URL patterns that aren't an element's own address.
 *
 * Each maps a pattern to a template. Craft strips a trailing page segment
 * (/p2) before matching, so a paginated listing works under these too.
 */

return [
    // A year of notes: /notes/2020. Four digits, so a topic slug can never be
    // mistaken for a year (or the other way round).
    'notes/<year:\d{4}>' => ['template' => '_views/archive/notes-year'],

    // The notes RSS feed. A .rss suffix rather than /notes/feed, so it can never
    // collide with a note or topic slug — both live at notes/{slug}, and a note called
    // "feed" would otherwise shadow it.
    'notes.rss' => ['template' => '_views/feeds/notes'],

    // llms.txt — the site described in markdown for a language model, per
    // llmstxt.org. Generated from the CMS rather than kept as a file at the webroot,
    // so it cannot drift out of step with what is actually published.
    'llms.txt' => ['template' => '_views/feeds/llms'],
    // llms-full.txt — the same site with every page's full text inline, so a model can
    // read the lot in one fetch instead of following each link.
    'llms-full.txt' => ['template' => '_views/feeds/llms-full'],
    // {uri}.md — one page as Markdown (_views/feeds/page-md); the homepage is index.md.
    '<path:[a-z0-9\-/]+>.md' => ['template' => '_views/feeds/page-md'],

    // The contact form on its own, for the contact panel to fetch when it opens
    // (see _views/fragments/contact-form). Not a page: 404 unless asked for by script.
    'fragments/contact-form' => ['template' => '_views/fragments/contact-form'],
];
