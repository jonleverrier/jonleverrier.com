<?php

namespace modules\frontend\helpers;

use craft\base\ElementInterface;
use craft\elements\Asset;
use craft\elements\Entry;

/**
 * Social — the image a page shows when its link unfurls (Open Graph / Twitter).
 */
final class Social
{
    /** The share image's size: what every platform's card is built around. */
    public const WIDTH = 1200;
    public const HEIGHT = 630;

    /**
     * The image for a page, in order of preference:
     *
     *   1. its own Social Image field, when set — the author's override;
     *   2. the first image in its content blocks — a large image, a legacy
     *      image, or the first of a two- or three-up — so a post with pictures
     *      shares with one of them and nobody has to upload it twice;
     *   3. the site default: the Social Image on the Globals entry.
     *
     * Null when there's nothing at all, in which case the head emits no image
     * tags rather than a broken one.
     */
    public static function image(?ElementInterface $element): ?Asset
    {
        $own = $element ? self::ownImage($element) : null;
        if ($own) {
            return $own;
        }

        $globals = Entry::find()->section('globals')->status(Entry::STATUS_LIVE)->one();

        return $globals ? self::fieldAsset($globals, 'socialImage') : null;
    }

    /**
     * The element's OWN image — its Social Image, else the first in its
     * content — with no site default: for a listing card, where a page with no
     * picture of its own should show none rather than the same default on every
     * card.
     */
    public static function ownImage(ElementInterface $element): ?Asset
    {
        return self::fieldAsset($element, 'socialImage') ?? self::firstContentImage($element);
    }

    /**
     * The image's URL at the share size — cropped from the asset's focal point,
     * as a JPEG. Generated NOW, not lazily: a lazy transform URL is a redirect
     * to the file once it exists, and link scrapers don't reliably follow one.
     * The meta tag has to name the real file.
     */
    public static function url(Asset $asset): string
    {
        return (string) $asset->getUrl([
            'width' => self::WIDTH,
            'height' => self::HEIGHT,
            'mode' => 'crop',
            'format' => 'jpg',
            'quality' => 80,
        ], true);
    }

    private static function firstContentImage(ElementInterface $element): ?Asset
    {
        $blocks = self::fieldValue($element, 'caseContent');
        if (!$blocks) {
            return null;
        }
        // Per block type, the field that carries its (first) picture.
        $imageFields = [
            'largeImage' => 'largeImage',
            'legacyImage' => 'legacyImage',
            'twoUpImage' => 'twoUpImagePrimary',
            'threeUpImage' => 'threeUpImagePrimary',
        ];
        foreach ($blocks->all() as $block) {
            $field = $imageFields[$block->getType()->handle] ?? null;
            if ($field) {
                $asset = self::fieldAsset($block, $field);
                if ($asset) {
                    return $asset;
                }
            }
        }

        return null;
    }

    private static function fieldAsset(ElementInterface $element, string $handle): ?Asset
    {
        $value = self::fieldValue($element, $handle);
        if (!$value) {
            return null;
        }
        $asset = $value->one();

        return $asset instanceof Asset && $asset->kind === Asset::KIND_IMAGE ? $asset : null;
    }

    private static function fieldValue(ElementInterface $element, string $handle)
    {
        try {
            return $element->getFieldValue($handle);
        } catch (\Throwable $e) {
            return null; // the field isn't on this element's layout
        }
    }
}
