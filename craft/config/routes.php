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

    // The homepage audit form. A ROUTE AND NOT A SINGLE, and only until the page it
    // belongs on is decided: everything else here is an element with its own address so
    // its copy can be written in the control panel. This exists so the form can be seen
    // and submitted meanwhile. See _views/page/audit.twig.
    'audit' => ['template' => '_views/page/audit'],

    // llms.txt — the site described in markdown for a language model, per
    // llmstxt.org. Generated from the CMS rather than kept as a file at the webroot,
    // so it cannot drift out of step with what is actually published.
    'llms.txt' => ['template' => '_views/feeds/llms'],
];
