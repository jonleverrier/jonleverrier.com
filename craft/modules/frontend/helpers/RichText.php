<?php

namespace modules\frontend\helpers;

/**
 * RichText — a CKEditor field's HTML, with the names the editor chooses for itself
 * replaced by the site's own.
 */
final class RichText
{
    /**
     * Prepares CKEditor's table wrapper: renames it, and makes it reachable.
     *
     * THE RENAME. The editor wraps every table it emits in `<figure class="table">`.
     * That class is hardcoded in its table plugin — there is no setting for it — and
     * `table` is about as generic as a class name gets, so styling it would mean
     * claiming a word any other part of the site could reasonably want. It arrives as
     * `c-table` instead, and the component owns its own name (components/_table.scss).
     *
     * THE TABINDEX. That figure is the scroll container: a wide table doesn't wrap
     * itself into a phone, it stays its own width and the wrapper scrolls sideways.
     * A scroll container that only answers to a swipe strands anyone driving from the
     * keyboard at the left-hand columns, with no way to reach the rest (WCAG 2.1.1),
     * and an element only takes arrow keys if it can hold focus. One attribute fixes
     * it; the focus ring it earns is drawn in the component.
     *
     * No `role="region"` with it, deliberately. The usual pairing wants a label to go
     * with the role, and there is nothing here to write one from — a CKEditor table
     * carries no caption — so it would announce an unnamed region on every table. A
     * focusable scroller with no role is the honest version of what this is.
     *
     * A REGEX, not DOMDocument, unlike Headings next door. That helper walks the tree
     * because it has to read each heading's text and hand ids back to its caller; this
     * changes one attribute and adds another. Going through DOMDocument would mean
     * parsing and re-serialising an author's entire page to do it — every entity,
     * every void tag and every attribute quote rewritten on the way out — which is all
     * downside for a change this size.
     *
     * Only the token `table` goes, and only on a <figure>. Every other class on the
     * same element is kept: CKEditor writes its alignment options here too, and a
     * figure an author has centred should still be centred afterwards.
     */
    public static function prepare(string $html): string
    {
        // Nothing to do on the overwhelming majority of fields, and this saves the
        // regex engine walking them.
        if (stripos($html, '<figure') === false) {
            return $html;
        }

        return preg_replace_callback(
            '/(<figure\b[^>]*?\bclass=")([^"]*)(")/i',
            static function (array $match): string {
                $classes = preg_split('/\s+/', trim($match[2]), -1, PREG_SPLIT_NO_EMPTY) ?: [];
                if (!in_array('table', $classes, true)) {
                    return $match[0];
                }

                $renamed = array_map(
                    static fn (string $class): string => $class === 'table' ? 'c-table' : $class,
                    $classes,
                );

                return $match[1] . implode(' ', $renamed) . $match[3] . ' tabindex="0"';
            },
            $html,
        ) ?? $html;
    }
}
