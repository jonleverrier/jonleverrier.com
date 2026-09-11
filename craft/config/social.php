<?php

/**
 * Jon's public profiles.
 *
 * ONE list, two consumers: the footer icons (_includes/page/social.twig) and
 * the Person node's `sameAs` in the JSON-LD (_includes/page/scripts.twig).
 *
 * They have to be the same URLs. `sameAs` is how a search engine or an AI
 * system decides that the Jon Leverrier who owns this site is the Jon
 * Leverrier behind that LinkedIn profile — a claim it will sanity-check
 * against the links the page actually shows. A profile listed in the schema
 * but missing from the footer is an unbacked claim; one in the footer but
 * missing from the schema is a link nothing joins up. Keeping two hand-typed
 * lists in step is exactly the trap the testimonial `company` field fell into,
 * so there is only one list.
 *
 * `handle` is the BEM modifier on the footer icon (.b-social__link--github) and
 * has to match a rule in build/scss/base/_social.scss — that's where the icon
 * comes from, so a profile added here without one renders as a blank space.
 * Available: linkedin, instagram, flickr, github, dribbble.
 *
 * Order is display order in the footer.
 *
 * Read in Twig as:
 *   craft.app.config.getConfigFromFile('social')
 */

return [
    ['handle' => 'linkedin', 'name' => 'LinkedIn', 'url' => 'https://www.linkedin.com/in/jonleverrier'],
    ['handle' => 'instagram', 'name' => 'Instagram', 'url' => 'https://www.instagram.com/jonleverrier'],
    ['handle' => 'flickr', 'name' => 'Flickr', 'url' => 'https://www.flickr.com/photos/jonleverrier'],
    ['handle' => 'github', 'name' => 'Github', 'url' => 'https://github.com/jonleverrier'],
];
