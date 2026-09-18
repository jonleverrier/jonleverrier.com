<?php

namespace modules\frontend\variables;

use Craft;
use craft\elements\Asset;
use craft\elements\Category;
use craft\elements\Entry;
use modules\frontend\helpers\CaseStudies;
use modules\frontend\helpers\Headings;
use modules\frontend\helpers\Notes;
use modules\frontend\helpers\RichText;
use modules\frontend\helpers\Social;
use modules\frontend\helpers\Testimonials;
use modules\jonson\Jonson;
use nystudio107\pluginvite\helpers\FileHelper;
use nystudio107\vite\Vite;
use Twig\Markup;

/**
 * Template helpers exposed as `craft.frontend`.
 *
 * @author You & Me Digital
 * @since  1.0.0
 */
class FrontEndVariable
{
    /** @var string[]|null Memo for roles() — see the note there. */
    private static ?array $roles = null;

    /** @var int[]|null Memo for notesHiddenByTopic() — see the note there. */
    private static ?array $hiddenNotes = null;

    /** The purposeOptions value meaning "show this to everyone" — see ctas(). */
    private const CTA_GENERAL = 'general';

    /** @var Entry[]|null Memo for ctas() — see the note there. */
    private static ?array $ctas = null;

    /** Name of the cookie recording which build's critical CSS the visitor already has. */
    private const CRITICAL_COOKIE = 'criticalcss';

    /** Roughly three months. */
    private const CRITICAL_COOKIE_LIFETIME = 7890000;

    /**
     * Has this visitor already been served the current build's critical CSS?
     *
     * Not a pure getter: a miss WRITES the cookie as well as reporting one, so the
     * next page load is a hit. That's the whole mechanism — inline the critical CSS
     * on the first view of a build, skip it on every view after.
     *
     * The cookie holds the hash of the bundled CSS, so a deploy invalidates it
     * automatically: a new hash can't match the stored one, and the visitor gets the
     * inline copy once more.
     */
    public function hasCriticalCssCookie(): bool
    {
        // Read out of the Vite manifest, so it's empty if the plugin is missing or the
        // build hasn't been run. Either way the critical CSS just gets inlined every
        // time, which is the safe way to be wrong.
        $hash = Vite::$plugin?->helper->getCssHash('build/js/app.js') ?? '';

        if (($_COOKIE[self::CRITICAL_COOKIE] ?? null) === $hash) {
            return true;
        }

        // Set raw rather than through Craft's response cookies. Yii signs those with an
        // HMAC when cookie validation is on, which would make the value unreadable to
        // anything outside PHP — an edge cache or a bit of JS keying off the build hash.
        // Nothing here needs tamper-proofing: the worst a forged value can do is skip an
        // inline stylesheet the visitor would then load normally.
        setcookie(self::CRITICAL_COOKIE, $hash, [
            'expires' => time() + self::CRITICAL_COOKIE_LIFETIME,
            'path' => '/',
            // Chrome drops Secure cookies on plain http, so a hard-coded true would make
            // this silently do nothing on any non-https environment.
            'secure' => Craft::$app->getRequest()->getIsSecureConnection(),
            'samesite' => 'Lax',
        ]);

        return false;
    }

    /**
     * Read a cookie from the template, or null if it isn't set.
     */
    public function cookieValue(string $name): ?string
    {
        return $_COOKIE[$name] ?? null;
    }

    /**
     * The client a testimonial belongs to — its linked case study's name, or the
     * typed `company` when there's no link. See Testimonials::company().
     *
     * Templates reach it as `craft.frontend.testimonialCompany(t)`; the Jonson
     * module calls the helper directly, so both sides give the same answer.
     */
    /**
     * A note's reading time in whole minutes — one calculation, shared by the
     * note itself and the index that lists it, so the two never disagree.
     * Templates reach it as `craft.frontend.readingTime(entry)`.
     */
    /**
     * The image a page shares with — its own Social Image, else the first in its
     * content, else the site default — or null. See helpers/Social for the chain.
     * Templates reach it as `craft.frontend.socialImage(element)`.
     */
    public function socialImage(?\craft\base\ElementInterface $element): ?Asset
    {
        return Social::image($element);
    }

    /**
     * An element's own image — Social Image, else the first in its content — or
     * null; no site default. For listing cards. `craft.frontend.ownImage(entry)`.
     */
    public function ownImage(\craft\base\ElementInterface $element): ?Asset
    {
        return Social::ownImage($element);
    }

    /** That image's URL at the share size (1200 × 630, cropped from the focal point). */
    public function socialImageUrl(Asset $asset): string
    {
        return Social::url($asset);
    }

    /**
     * The h2s across a set of content blocks, given ids and listed — for an
     * "on this page" nav. Returns { headings: [{id, text}], html: {blockId: html} };
     * see helpers/Headings. `craft.frontend.headingAnchors(blocks)`.
     */
    public function headingAnchors(iterable $blocks): array
    {
        return Headings::anchor($blocks);
    }

    /**
     * A CKEditor field's HTML, ready to print. See helpers\RichText.
     *
     * Takes over the emptiness check the templates were each doing for themselves.
     * A CKEditor field returns a Markup object, which is TRUTHY EVEN WHEN EMPTY, so
     * `{% if entry.content %}` is always true and every caller had to remember
     * `|trim` to avoid rendering an empty prose block. Returning null for an empty
     * field puts that trap in one place instead of in each template.
     *
     * Markup back out, so a template still prints it with `|raw` exactly as it
     * printed the field.
     */
    public function richText($html): ?Markup
    {
        $source = trim((string) $html);

        return $source === '' ? null : new Markup(RichText::prepare($source), Craft::$app->charset);
    }

    public function readingTime(Entry $entry): int
    {
        return Notes::readingTime($entry);
    }

    public function testimonialCompany(?Entry $testimonial): string
    {
        return Testimonials::company($testimonial);
    }

    /**
     * The Client List entry a case study was for, or null. See CaseStudies::client().
     *
     * Returned as the entry rather than a name so a caller that needs more than the
     * name — the structured data wants an id to hang an Organization off — doesn't
     * have to follow the relation a second time.
     */
    public function caseStudyClient(?Entry $study): ?Entry
    {
        return CaseStudies::client($study);
    }

    /**
     * The client's name for a case study, '' when it has none. `long` asks for the
     * Client Long Title, which falls back to the short name.
     *
     * Templates reach these as `craft.frontend.caseStudyClientName(entry)`; the
     * Jonson module calls the helper directly, so both sides give the same answer.
     */
    public function caseStudyClientName(?Entry $study, bool $long = false): string
    {
        return CaseStudies::clientName($study, $long);
    }

    /** The client's logo for a case study, falling back to the study's own. */
    public function caseStudyClientLogo(?Entry $study): ?Asset
    {
        return CaseStudies::clientLogo($study);
    }

    /** `studies` with the ones sharing this study's client first, order otherwise kept. */
    public function caseStudiesBySharedClient(array $studies, ?Entry $study): array
    {
        return CaseStudies::orderBySharedClient($studies, $study);
    }

    /** A month. The probe encodes a tiny image, but there's no reason to repeat it
     *  on every request — the answer can only change when the host does. */
    private const AVIF_TTL = 2592000;

    /**
     * The quality AVIF transforms are encoded at.
     *
     * A number of its own, deliberately not derived from the `quality` the rest of
     * the <picture> uses. An earlier version worked out an offset from that number,
     * which was a mistake: the site's WebP quality is itself a hand-picked value, so
     * anchoring to it only inherited a guess. This is the AVIF encoder's own
     * setting and it's answerable on its own terms — how few bytes can it use and
     * still be indistinguishable from the original.
     *
     * 72, with AVIF_CHROMA in play. The measurement below was taken at 70; 72 is
     * that finding nudged up two points for headroom rather than a second
     * measurement. Measured against a lossless render of the same transform, and
     * then looked at 1:1 on the hardest thing on the site (fine coloured type on
     * flat brand colour):
     *
     *   4:2:0 q78, what shipped before → 23,555 bytes, and visibly wrong: the red
     *                                    full stop after a logotype goes dull and
     *                                    bleeds into the navy behind it
     *   4:4:4 q70                      → 17,642 bytes, and the dot is clean
     *
     * So it isn't a compromise between the two things — a quarter fewer bytes AND
     * visibly better than what it replaces, because the chroma change more than
     * pays for the lower number. Below about 65 the dotted texture inside the brand
     * marks starts to soften, which is the first thing to go on this imagery, so
     * there's a little room left but not much.
     */
    private const AVIF_QUALITY = 72;

    /**
     * Can this host actually encode AVIF?
     *
     * Asked because the failure mode is silent. ImageMagick reports AVIF in
     * queryFormats() whenever it was built against libheif, but libheif keeps its
     * codecs in separate plugin packages, and a build with only decoders can read
     * AVIF while being unable to write a byte of it. Craft doesn't surface the
     * difference: the transform is written, served as image/avif, and contains
     * JPEG. So the only trustworthy question is whether an encode actually
     * succeeds, which is what this does — on a 1×1 image, in memory.
     *
     * Called per <picture>, so it's cached; the answer is a property of the host.
     */
    public function supportsAvif(): bool
    {
        return (bool) Craft::$app->getCache()->getOrSet('supportsAvif', static function (): bool {
            // GD can encode AVIF too, but Craft's transforms only reach for it when
            // Imagick is absent, and answering for the driver that isn't doing the
            // work would be answering the wrong question.
            if (!Craft::$app->getImages()->getIsImagick()) {
                return function_exists('imageavif');
            }

            try {
                $im = new \Imagick();
                $im->newImage(1, 1, new \ImagickPixel('white'));
                $im->setImageFormat('avif');
                // getImageBlob() runs the encoder, so a missing delegate throws here
                // rather than reporting success and writing something else.
                $blob = $im->getImageBlob();
                $im->destroy();

                return $blob !== '';
            } catch (\Throwable $e) {
                Craft::info('AVIF encoding unavailable: ' . $e->getMessage(), __METHOD__);

                return false;
            }
        }, self::AVIF_TTL);
    }

    /**
     * The quality to ask for when transforming to AVIF.
     *
     * Takes no argument on purpose. The macro's `quality` option is a WebP and JPEG
     * setting; AVIF is encoded at its own measured value regardless, so raising the
     * one doesn't quietly move the other.
     */
    public function avifQuality(): int
    {
        return self::AVIF_QUALITY;
    }

    /** Working size for the colour read. Big enough to be representative, small
     *  enough that quantising it costs nothing. */
    private const TONE_SIZE = 48;

    /** How many colours to reduce the image to before picking. Few enough that
     *  each one stands for a real region of the picture rather than a shade. */
    private const TONE_COLOURS = 6;

    /** A month. The image can't change without changing the cache key. */
    private const TONE_TTL = 2592000;

    /**
     * The two dominant colours of an asset, as ['a' => '#rrggbb', 'b' => '#rrggbb'],
     * or null if they can't be read.
     *
     * Used as a gradient standing in for the image until it loads. Deliberately
     * NOT a miniature of the image: two hex strings are ~14 bytes inlined against
     * ~200 for even a tiny encoded thumbnail, and a flat wash reads as a
     * considered placeholder where a blurred thumbnail reads as a broken photo.
     *
     * Quantised rather than averaged. Averaging a picture collapses it toward
     * mud — a red logo on a blue field averages to grey, which is the one colour
     * that isn't in it. Reducing to a handful of colours and taking the two most
     * common gives back colours that are actually present.
     *
     * Keyed by last-modified, so re-uploading an asset invalidates it by itself.
     */
    public function imageTones(?Asset $asset): ?array
    {
        // Only raster images have pixels to read. An SVG would sail through
        // getCopyOfFile() and fail somewhere less obvious inside Imagick.
        if (!$asset || $asset->kind !== Asset::KIND_IMAGE || $asset->getExtension() === 'svg') {
            return null;
        }

        $key = 'tones:' . $asset->id . ':' . ($asset->dateModified?->getTimestamp() ?? 0);

        return Craft::$app->getCache()->getOrSet($key, function () use ($asset): ?array {
            $copy = null;
            try {
                $copy = $asset->getCopyOfFile();
                $images = Craft::$app->getImages();

                // Imagick only. GD has no quantiser worth the name here, and a host
                // without Imagick simply gets no placeholder — the image then shows
                // normally, which is a fine way to be missing a flourish.
                if (!$images->getIsImagick()) {
                    return null;
                }

                $im = new \Imagick($copy);
                $im->stripImage();
                $im->setImageColorspace(\Imagick::COLORSPACE_SRGB);
                $im->scaleImage(self::TONE_SIZE, self::TONE_SIZE, true);
                $im->quantizeImage(self::TONE_COLOURS, \Imagick::COLORSPACE_RGB, 0, false, false);

                $counts = [];
                foreach ($im->getImageHistogram() as $pixel) {
                    $c = $pixel->getColor();
                    $counts[] = [
                        'n' => $pixel->getColorCount(),
                        'rgb' => [$c['r'], $c['g'], $c['b']],
                    ];
                }
                $im->destroy();

                if (!$counts) {
                    return null;
                }

                usort($counts, static fn($x, $y) => $y['n'] <=> $x['n']);

                $a = $counts[0]['rgb'];

                // Second colour: the most common one that is actually DISTINCT from
                // the first. Quantising often returns near-neighbours at the top, and
                // a gradient between two shades of the same colour is just a flat
                // fill with extra steps.
                $b = null;
                foreach (array_slice($counts, 1) as $cand) {
                    if (self::toneDistance($a, $cand['rgb']) > 60) {
                        $b = $cand['rgb'];
                        break;
                    }
                }

                // Nothing distinct enough — a genuinely monochrome image. Derive the
                // second end by shifting the first, so the gradient still has a
                // direction to it instead of collapsing to one colour.
                $b ??= self::toneShift($a, 0.82);

                return ['a' => self::toneHex($a), 'b' => self::toneHex($b)];
            } catch (\Throwable $e) {
                Craft::error('imageTones ' . $asset->id . ': ' . $e->getMessage(), __METHOD__);

                return null;
            } finally {
                if ($copy !== null) {
                    @unlink($copy);
                }
            }
        }, self::TONE_TTL);
    }

    /** A month. Keyed by last-modified, like the tones, so it can't go stale. */
    private const LOTTIE_TTL = 2592000;

    /**
     * The composition size of a Lottie JSON asset, as ['w' => int, 'h' => int], or
     * null if it can't be read.
     *
     * The template writes it as an aspect-ratio on the box, so the space is reserved
     * before the player has loaded — the same job width/height do on an <img>. A
     * Lottie's own `w`/`h` are the only place that ratio lives, and they're inside
     * a file that can run to megabytes (embedded images are base64), so it's read
     * once per asset version and cached rather than decoded on every page view.
     */
    public function lottieSize(?Asset $asset): ?array
    {
        if (!$asset || $asset->kind !== Asset::KIND_JSON) {
            return null;
        }

        $key = 'lottie-size:' . $asset->id . ':' . ($asset->dateModified?->getTimestamp() ?? 0);

        return Craft::$app->getCache()->getOrSet($key, static function () use ($asset): ?array {
            try {
                $data = json_decode($asset->getContents(), true);
                $w = (int) ($data['w'] ?? 0);
                $h = (int) ($data['h'] ?? 0);

                return ($w > 0 && $h > 0) ? ['w' => $w, 'h' => $h] : null;
            } catch (\Throwable $e) {
                Craft::error('lottieSize ' . $asset->id . ': ' . $e->getMessage(), __METHOD__);

                return null;
            }
        }, self::LOTTIE_TTL);
    }

    /**
     * Jon's project journey for the method timeline — the same phases the [[method]]
     * marker gives a Jonson answer, so a static page (About) can show the identical
     * component. Delegates to the Jonson module's context finder, which owns the
     * shape: a list of { title, summary, services }.
     */
    public function methodology(): array
    {
        return Jonson::getInstance()->findContext->methodology();
    }

    /**
     * The lines under the name in the header — what Jon is, one at a time.
     *
     * ONE list, TWO consumers, and that is the whole reason this lives in code rather
     * than being read straight out of the field in each template: the cycling ticker in
     * _includes/page/logo.twig shows all of them in order, and the Person node's
     * `jobTitle` in _includes/page/scripts.twig takes the FIRST one only. The schema
     * must not be able to claim a title the site does not show, so both ask here.
     *
     * Source is the Global entry's `jobTitles` table field, one `title` column. Blank
     * rows are dropped — a table field keeps whatever the CP left behind, and an empty
     * row would print as a blank line in the ticker and, if it landed first, hand the
     * schema an empty jobTitle.
     *
     * Falls back to config/roles.php when the field is empty or the entry is missing.
     * Not for tidiness: the ticker is in the header of every page, so an empty field
     * would silently blank a line under the name site-wide, and the JSON-LD would drop
     * its jobTitle without anything looking broken.
     *
     * Memoised — the header renders once per request but the schema asks again, and
     * neither should cost a second query.
     */
    public function roles(): array
    {
        if (self::$roles !== null) {
            return self::$roles;
        }

        // 'globals', plural — the section handle (see project config). Worth being
        // careful with: the entry type inside it is named 'global', singular.
        $global = Entry::find()->section('globals')->one();
        $rows = $global?->jobTitles ?? [];

        $titles = [];
        foreach ($rows as $row) {
            $title = trim((string) ($row['title'] ?? ''));
            if ($title !== '') {
                $titles[] = $title;
            }
        }

        if (!$titles) {
            $titles = Craft::$app->getConfig()->getConfigFromFile('roles');
        }

        return self::$roles = $titles;
    }

    /**
     * Note IDs to keep off the /notes index, because a topic they carry is marked
     * "Hide entries from index?" (a Lightswitch on the Topics category group).
     *
     * IDs rather than a filtered query, because the caller builds its own query and
     * needs the exclusion to apply BEFORE `paginate` — the index's page count comes
     * from `count()` on the same query, so filtering after the fact would leave the
     * pagination claiming pages that no longer exist.
     *
     * This is the INDEX only, and deliberately so. The topic keeps its pill in the
     * topics panel and its own page at /notes/{topic}, which is the whole point: the
     * writing stays reachable and indexable, it just does not fill the front page.
     * Nothing here touches the sitemap, which queries sections directly.
     *
     * A note carrying two topics, one hidden and one not, is hidden — being related to
     * ANY hidden topic is enough. That is the reading the switch's name asks for, and
     * the safer one: the alternative surfaces a note the author has asked to bury.
     */
    /**
     * The CTAs to show this visitor — the globals single's `ctas` matrix, minus any
     * whose Purpose does not apply.
     *
     * A CTA carries a Purpose checkbox set (`purposeOptions`); a VIP door carries one
     * `purpose` from the same list, minus 'general'. The rule:
     *
     *   'general' ticked    → shown to everyone, VIP or not. This is the ONLY way a CTA
     *                         reaches an ordinary visitor.
     *   a purpose ticked    → shown to a visitor who came through a VIP door with that
     *                         purpose. No door, or a door with the dropdown left blank,
     *                         and it stays hidden.
     *   nothing ticked      → shown to nobody. Not an oversight: showing it would mean
     *                         guessing, and the guess is wrong either way — treat a
     *                         blank field as "everyone" and a CTA written for one person
     *                         leaks to the whole site the moment someone forgets to tick
     *                         a box. Silence is the safe reading, and an empty Purpose
     *                         is visibly empty in the CP.
     *
     * The two combine: 'general' plus 'lookingForAJob' is an ordinary CTA that also
     * suits that door. And 'general' is additive, not exclusive — a VIP still sees the
     * general CTAs, because losing "Send me an email" is not something being recognised
     * at the door should cost you.
     *
     * Resolved once: three templates render this list (footer, contact page, contact
     * panel) and each used to fetch the globals single for itself.
     */
    /**
     * A URL from the CMS with invisible Unicode stripped out.
     *
     * Copy a phone number out of Contacts, WhatsApp or a messaging app on a Mac or a
     * phone and you get a bidi control character with it — the WhatsApp CTA arrived
     * carrying U+202D LEFT-TO-RIGHT OVERRIDE between the slash and the number. It is a
     * real character in the string, so it is percent-encoded into the href
     * (`%E2%80%AD`) and the link 404s, but it has no glyph: it cannot be seen in the CP,
     * it cannot be selected, and there is nothing to delete. An author can only retype
     * the whole field and hope.
     *
     * So the strip happens here rather than being left to whoever pastes next. Bidi
     * controls, zero-width characters and the BOM — everything in this class is
     * invisible, and none of it is ever meant in a URL.
     *
     * Deliberately NOT a general cleaner: no case changes, no scheme guessing, no
     * trailing-slash opinions. Removing characters that cannot be seen is a fix; the
     * rest would be this code overruling what the author typed.
     */
    public function safeUrl(?string $url): ?string
    {
        if ($url === null) {
            return null;
        }

        $clean = preg_replace(
            '/[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{FEFF}]/u',
            '',
            $url,
        );

        return trim($clean ?? $url);
    }

    public function ctas(): array
    {
        if (self::$ctas !== null) {
            return self::$ctas;
        }

        $globals = Entry::find()->section('globals')->one();
        $all = $globals?->ctas?->all() ?? [];

        $vip = Jonson::getInstance()->vip;
        $door = $vip->current();
        $purpose = $door ? $vip->purpose($door) : '';

        $shown = [];
        foreach ($all as $cta) {
            $wanted = [];
            foreach ($cta->purposeOptions ?? [] as $option) {
                $value = trim((string) $option->value);
                if ($value !== '') {
                    $wanted[] = $value;
                }
            }

            $everyone = in_array(self::CTA_GENERAL, $wanted, true);
            $thisDoor = $purpose !== '' && in_array($purpose, $wanted, true);

            if ($everyone || $thisDoor) {
                $shown[] = $cta;
            }
        }

        return self::$ctas = $shown;
    }

    /**
     * The CTAs this visitor's DOOR unlocked — the subset of ctas() whose Purpose names
     * the purpose on the vip entry they came through. Empty for everyone else.
     *
     * Separate from ctas() because the two answer different questions. ctas() is "what
     * may this visitor be shown", which the footer, contact page and contact panel all
     * want. This is "what did being recognised at the door earn them", which is the only
     * thing Jonson's contact beat inside a reply adds to its one button: a general CTA
     * ticked for the footer has no business widening a beat that sits mid-conversation.
     *
     * A CTA ticked 'general' AND for this purpose counts as the door's — it was written
     * with this visitor in mind, whoever else also sees it.
     *
     * Reads through ctas(), so it costs no second query.
     */
    /**
     * Which icon a CTA shows — 'phone', 'email', 'whatsapp', 'callback' or 'generic'.
     *
     * Read off the LINK, not off a field Jon has to remember to set: the Link field
     * already knows a tel: from a mailto:, and those two carry the two icons that are
     * never ambiguous. The remaining two are host matches, because "a WhatsApp" and "a
     * booking page" are things a URL says rather than things a type does.
     *
     * Everything unrecognised gets 'generic' rather than nothing, so a CTA Jon adds
     * tomorrow arrives with a mark beside it instead of a gap where the others have one.
     */
    public function ctaIcon($cta): string
    {
        $link = $cta->ctaUrl ?? null;
        $type = strtolower(trim((string) ($link->type ?? '')));
        if ($type === 'tel') {
            return 'phone';
        }
        if ($type === 'email') {
            return 'email';
        }

        $host = strtolower((string) parse_url((string) ($link->value ?? ''), PHP_URL_HOST));
        if ($host === '') {
            return 'generic';
        }
        if (str_contains($host, 'wa.me') || str_contains($host, 'whatsapp')) {
            return 'whatsapp';
        }
        if ($host === 'cal.com' || str_ends_with($host, '.cal.com')) {
            return 'callback';
        }

        return 'generic';
    }

    public function doorCtas(): array
    {
        $vip = Jonson::getInstance()->vip;
        $door = $vip->current();
        $purpose = $door ? $vip->purpose($door) : '';
        if ($purpose === '') {
            return [];
        }

        return array_values(array_filter($this->ctas(), static function ($cta) use ($purpose) {
            foreach ($cta->purposeOptions ?? [] as $option) {
                if (trim((string) $option->value) === $purpose) {
                    return true;
                }
            }

            return false;
        }));
    }

    public function notesHiddenByTopic(): array
    {
        if (self::$hiddenNotes !== null) {
            return self::$hiddenNotes;
        }

        $hiddenTopics = Category::find()
            ->group('topics')
            ->hideEntriesFromIndex(true)
            ->ids();

        if (!$hiddenTopics) {
            return self::$hiddenNotes = [];
        }

        return self::$hiddenNotes = Entry::find()
            ->section('notes')
            ->status(null) // exclusion by id — status is the index query's business
            ->relatedTo($hiddenTopics)
            ->ids();
    }

    /** Straight-line distance in RGB. Crude next to a perceptual space, but this
     *  only has to answer "are these two obviously different colours". */
    private static function toneDistance(array $x, array $y): float
    {
        return sqrt(
            ($x[0] - $y[0]) ** 2 +
            ($x[1] - $y[1]) ** 2 +
            ($x[2] - $y[2]) ** 2
        );
    }

    /** Darken (factor < 1) or lighten (> 1), clamped. */
    private static function toneShift(array $rgb, float $factor): array
    {
        return array_map(
            static fn($v) => (int) max(0, min(255, round($v * $factor))),
            $rgb,
        );
    }

    private static function toneHex(array $rgb): string
    {
        return sprintf('#%02x%02x%02x', $rgb[0], $rgb[1], $rgb[2]);
    }

    /**
     * URLs of the chunks a manifest entry statically imports.
     *
     * For preloading a dynamic import's dependencies. `craft.vite.asset()` resolves
     * one entry and stops there: a dynamically-imported chunk's OWN static imports
     * are not reachable through it. Naming the parent in a modulepreload does not
     * reach them either — Chrome fetches the module named in the tag and does not
     * walk its import graph, which is measurable: with only hero.js named, three was
     * requested script-initiated ~1.3s in, and with this it is parser-initiated at
     * ~0.3s alongside the bundle.
     *
     * Resolved THROUGH the manifest rather than written out as a filename, because
     * the chunk carries a content hash — three.module.<hash>.js — and a hard-coded
     * one stops matching the day the dependency is updated. That failure would be
     * silent in the way this codebase keeps getting caught by: a preload pointing at
     * a URL that 404s costs a request, warns only in the console, and leaves the page
     * working normally otherwise.
     *
     * Empty while the dev server is running — it serves modules individually and
     * there is no manifest to read — and empty rather than throwing if the manifest
     * is missing or unreadable, which just means no preload hint.
     */
    public function chunkImports(string $path): array
    {
        $vite = Vite::$plugin?->vite;
        if ($vite === null || $vite->devServerRunning()) {
            return [];
        }

        $manifest = self::viteManifest($vite->manifestPath);
        $urls = [];

        foreach ($manifest[$path]['imports'] ?? [] as $key) {
            $file = $manifest[$key]['file'] ?? null;
            if ($file !== null) {
                $urls[] = FileHelper::createUrl($vite->serverPublic, $file);
            }
        }

        return $urls;
    }

    /** The decoded Vite manifest, memoized for the request. */
    private static function viteManifest(string $path): array
    {
        if (self::$viteManifest !== null) {
            return self::$viteManifest;
        }

        $json = is_readable($path) ? file_get_contents($path) : false;
        $decoded = $json === false ? null : json_decode($json, true);

        return self::$viteManifest = is_array($decoded) ? $decoded : [];
    }

    /** @var array|null Memoized manifest, see viteManifest(). */
    private static ?array $viteManifest = null;
}
