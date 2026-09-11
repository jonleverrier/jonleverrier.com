<?php

namespace modules\frontend\services;

use Craft;
use craft\base\Image;
use craft\image\Raster;
use craft\services\Images as BaseImages;
use Imagine\Imagick\Image as ImagickImage;

/**
 * Craft's image service, with the two AVIF encoder settings that Craft has no
 * opinion about.
 *
 * Neither can be reached through a transform: Craft hands Imagine a quality and
 * nothing else, and Imagine's AVIF branch only knows about quality and lossless.
 * So the options are set on the Imagick instance as it's loaded, before anything
 * has asked what format the output will be — which is harmless, since a JPEG or
 * WebP write ignores them.
 *
 * @author You & Me Digital
 * @since  1.0.0
 */
class Images extends BaseImages
{
    /**
     * Chroma subsampling. The single biggest lever on this site's imagery, and the
     * reason this class exists.
     *
     * ImageMagick defaults AVIF to 4:2:0 — chroma at half resolution in both axes,
     * which is the right default for photographs, where the eye genuinely doesn't
     * track colour detail that finely. This site's images are mostly not
     * photographs. They're UI, brand marks, and coloured type on flat brand
     * colour, and 4:2:0 mangles exactly that: a small red full stop next to white
     * text on navy loses its saturation and bleeds into the background.
     *
     * It also isn't the trade it sounds like. Reconstructing an edge the chroma
     * pass smeared costs the encoder bits, so on this content 4:4:4 is smaller AND
     * closer to the original at the same quality — measured over a spread of the
     * site's images, 4:4:4 beat 4:2:0 at every point on the quality curve:
     *
     *   4:2:0 q80 → 277,784 bytes, DSSIM 0.00468
     *   4:4:4 q70 → 240,102 bytes, DSSIM 0.00436   (14% smaller, and better)
     *
     * On a photograph-heavy site the default would be the better call.
     */
    public const AVIF_CHROMA = '444';

    /**
     * aom's effort setting, 0 (slowest, smallest) to 10. ImageMagick's default is
     * 6; 5 is ~5% smaller at slightly better fidelity, and past 5 the curve
     * flattens while the clock keeps running (2 costs 13x the time of 6 for 10%).
     *
     * Worth paying because a transform is encoded once and then served forever.
     * The bill lands on whoever loads an uncached page first — see
     * generateTransformsBeforePageLoad in general.php, which makes that a visitor
     * rather than a queue worker. Drop this to 6 if that ever becomes the problem;
     * it costs 5% of the saving, not the AVIF support.
     */
    public const AVIF_SPEED = '5';

    /**
     * @inheritdoc
     */
    public function loadImage(string $path, bool $rasterize = false, int $svgSize = 1000): Image
    {
        $image = parent::loadImage($path, $rasterize, $svgSize);

        // Not an error worth raising: GD, an SVG, or a future Imagine that hands
        // back something else all just mean the defaults apply.
        if ($image instanceof Raster) {
            $imagineImage = $image->getImagineImage();

            if ($imagineImage instanceof ImagickImage) {
                // Set on the Imagick itself, and Imagine's resize/crop mutate that
                // same instance rather than replacing it, so the options survive the
                // transform and are still in place at write time.
                $imagick = $imagineImage->getImagick();
                $imagick->setOption('heic:chroma', self::AVIF_CHROMA);
                $imagick->setOption('heic:speed', self::AVIF_SPEED);
            }
        }

        return $image;
    }
}
