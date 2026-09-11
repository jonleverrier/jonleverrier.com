<?php

namespace modules\frontend\helpers;

use craft\helpers\StringHelper;

/**
 * Headings — the section headings in a page's prose, made linkable.
 */
final class Headings
{
    /**
     * Gives every h2 across a set of content blocks an id and lists them, so a
     * page can carry an "on this page" nav of real anchors.
     *
     * Ids come from the heading's own text, slugified, and are deduped across
     * the whole set — two sections called "Examples" become examples and
     * examples-2 — so a link never lands on the wrong one. Blocks that aren't
     * prose are left alone.
     *
     * Returns ['headings' => [['id' => …, 'text' => …], …],
     *          'html'     => [blockId => the block's HTML with the ids in]].
     */
    public static function anchor(iterable $blocks): array
    {
        $headings = [];
        $html = [];
        $used = [];

        foreach ($blocks as $block) {
            if ($block->getType()->handle !== 'content') {
                continue;
            }
            $source = trim((string) ($block->content ?? ''));
            if ($source === '' || stripos($source, '<h2') === false) {
                continue;
            }
            $html[$block->id] = self::anchorHtml($source, $headings, $used);
        }

        return ['headings' => $headings, 'html' => $html];
    }

    private static function anchorHtml(string $source, array &$headings, array &$used): string
    {
        $doc = new \DOMDocument();
        libxml_use_internal_errors(true);
        // A UTF-8 hint and a wrapper, so the fragment parses as itself rather
        // than being wrapped in html/body and re-encoded.
        $doc->loadHTML(
            '<?xml encoding="utf-8" ?><div id="__root">' . $source . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD,
        );
        libxml_clear_errors();

        $root = $doc->getElementById('__root');
        if (!$root) {
            return $source;
        }

        foreach ($root->getElementsByTagName('h2') as $h2) {
            $text = trim($h2->textContent);
            if ($text === '') {
                continue;
            }
            $id = $h2->getAttribute('id') ?: StringHelper::slugify($text);
            $base = $id;
            for ($n = 2; isset($used[$id]); $n++) {
                $id = $base . '-' . $n;
            }
            $used[$id] = true;
            $h2->setAttribute('id', $id);
            $headings[] = ['id' => $id, 'text' => $text];
        }

        $out = '';
        foreach ($root->childNodes as $child) {
            $out .= $doc->saveHTML($child);
        }

        return $out;
    }
}
