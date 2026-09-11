<?php
/**
 * Cryptographer (miranj/craft-cryptographer) — used for one thing on this site: the
 * VIP door's alternate slug (see modules/jonson/services/Vip::altSlugFor). A short
 * lowercase token so the URL reads as a code, not a name — the person's own slug
 * still works alongside it.
 *
 * The token is STORED on the entry and resolved by lookup, never decoded, so the
 * hashids salt (Craft's securityKey) differing between environments changes nothing
 * about an already-minted link.
 */
return [
    'hashidsMinLength' => 8,
    'hashidsAlphabet' => 'abcdefghijklmnopqrstuvwxyz0123456789',
];
