<?php

/**
 * The lines under the name in the header — what Jon is, one at a time.
 *
 * ONE list, two consumers: the cycling description in the header
 * (_includes/page/logo.twig, all of them, in this order) and the Person node's
 * `jobTitle` in the JSON-LD (_includes/page/scripts.twig, the FIRST one only).
 *
 * So the order matters beyond the header: the first entry is the professional
 * title search engines and AI systems will file him under. Keep it the real
 * one. The rest can be as playful as they like — they only ever cycle past a
 * visitor, and never reach the schema.
 */
return [
    'Design Director',
    'Product Designer',
    'UX/UI Designer',
    'Design Engineer',
    'Brand Designer',
    'AI Designer',
    'Fully Grown Human',
];
