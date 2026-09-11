<?php
/**
 * General Configuration
 *
 * All of your system's general configuration settings go in here. You can see a
 * list of the available settings in vendor/craftcms/cms/src/config/GeneralConfig.php.
 *
 * @see \craft\config\GeneralConfig
 * @link https://craftcms.com/docs/5.x/reference/config/general.html
 */

use craft\config\GeneralConfig;
use craft\helpers\App;

$config = GeneralConfig::create()
    ->defaultWeekStartDay(1)
    ->omitScriptNameInUrls()
    ->preloadSingles()
    ->preventUserEnumeration()
    ->aliases([
        '@web' => App::env('URL_SITE_PUBLIC'),
        '@webroot' => App::env('PRIMARY_SITE_WEBROOT'),
    ])
    ->defaultCpLanguage('en-GB')
    ->defaultCpLocale('en-GB')
    // Control panel at /manager rather than Craft's default /admin.
    ->cpTrigger('manager')
    // Error templates live with the section views, not loose at the templates root.
    // Craft's lookup becomes `_views/<code>`, then `_views/offline` for a 503, then
    // `_views/error` — which is the only one that exists (see the note in it).
    ->errorTemplatePrefix('_views/')
    ->sendPoweredByHeader(false)
    // GraphQL off. Nothing on this site queries it — no tokens, no schema beyond the
    // one Craft creates itself — so it was a nav item pointing at an unused feature and
    // a query endpoint nobody was watching. This removes both; hiding only the nav item
    // would have been cosmetic, leaving the API live behind it.
    //
    // Turn it back on here if a headless client ever needs it; the Public Schema and
    // its settings survive in project config either way.
    ->enableGql(false)
    // A dedicated "SVG" file kind so an Assets field can be locked to SVG only.
    // (The built-in "image" kind also includes svg, so restricting a field to
    // "image" wouldn't exclude PNG/JPG.) Select "SVG" on the field's allowed
    // file types. svg is already in the default allowedFileExtensions.
    ->extraFileKinds([
        'svg' => [
            'label' => 'SVG',
            'extensions' => ['svg'],
        ],
    ])
    // Off, so a page is sent as soon as it's rendered and each transform is built
    // when a browser actually asks for that file.
    //
    // This was `true` for a while, to keep <source srcset> emitting direct file URLs
    // instead of generate-transform redirects. The redirects are still the cost —
    // one extra round trip per image, and a no-cache header on any page still
    // waiting on a transform — but they're only paid until each file has been built
    // once, and the thing they were buying wasn't worth it:
    //
    // · `true` blocks the HTML on every transform in the page. A cold case study
    //   took 76 seconds to send its first byte. It survived here only because DDEV
    //   sets fastcgi_read_timeout to 10m and max_execution_time to 0; on a stock
    //   nginx (60s) that visitor gets a 504, not a slow page.
    // · it builds the whole srcset matrix whether or not anyone wants it. That page
    //   references 78 transforms; a browser downloads about 5 of them. The other
    //   ~94% is encoding done on a visitor's clock for files nobody requested.
    //
    // Off, the cold case is a page that arrives immediately, shows its tone
    // placeholders, and fills in — and only builds the handful of sizes actually
    // requested. It makes the cold load survivable rather than fast; making it
    // invisible means building transforms after a deploy, so no visitor meets a
    // cold one.
    ->generateTransformsBeforePageLoad(false)
    // Never enlarge a source to fill a transform. Craft's default is `true`, which
    // means a srcset asking for widths above the original manufactures bigger files
    // with no more detail in them — real bytes, zero benefit. Off, an oversized
    // candidate resolves to the source instead, so a srcset can safely name retina
    // widths that only some assets are big enough to satisfy.
    ->upscaleImages(false)
;

// WHO THE VISITOR IS, behind Cloudflare — and, just as much, in front of it.
//
// Craft ships `trustedHosts = ['any']`, and Yii's own default ipHeaders is
// ['X-Forwarded-For']. Together those mean the request believes whatever forwarding
// header it is handed, from anyone. Measured, with Craft's defaults and no proxy at all:
//
//     attacker at 203.0.113.9 sends `X-Forwarded-For: 1.2.3.4`
//     getUserIP() returns 1.2.3.4
//
// Anything keyed on the visitor is therefore keyed on a value the visitor chooses. That
// is Jonson's rate limiter (AskController::withinRateLimit hashes getUserIP), which a
// script defeats completely by incrementing a header — a fresh allowance per request,
// while an honest visitor still gets thirty.
//
// The site is moving behind Cloudflare, which breaks the same thing from the other
// direction: every request would then arrive from a Cloudflare address, so ONE bucket
// would be shared by the entire internet.
//
// The three settings below fix both. Together they say: take the visitor's address from
// CF-Connecting-IP, but only when the request genuinely came from Cloudflare; from
// anyone else, use the address the connection actually came from.
//
//   trustedHosts   whose forwarding headers count for anything
//   ipHeaders      where the real address lives in those requests
//   secureHeaders  which headers are STRIPPED from everyone else
//
// secureHeaders is the one that is easy to miss and does the actual security work. Yii
// removes a header from an untrusted request only if it is named there; ipHeaders alone
// would leave CF-Connecting-IP readable on a direct hit to the origin — so someone who
// finds the origin address could mint a new identity per request, which is worse than
// no header at all. Named in both lists, an untrusted sender's copy is gone before
// getUserIP() looks. X-Forwarded-For is listed for the same reason: it is what is
// forgeable today.
//
// Craft's defaults are restated rather than extended — these arrays REPLACE Yii's, and
// dropping X-Forwarded-Proto would cost HTTPS detection behind the proxy.
//
// RANGES GO STALE. From cloudflare.com/ips-v4 and /ips-v6, 2026-09-11. They change
// rarely, and the failure is safe when they do: an unlisted edge falls back to its own
// address, so visitors share a bucket rather than anyone getting a forged one. Worth
// re-checking if the limiter starts firing for no reason.
//
// Firewall the origin to these ranges on 80/443 too. This fails safe without it, but
// there is no reason to serve anyone who skips the edge.
$config
    ->ipHeaders(['CF-Connecting-IP'])
    ->secureHeaders([
        // Yii's defaults, restated (see above).
        'X-Forwarded-For',
        'X-Forwarded-Host',
        'X-Forwarded-Proto',
        'X-Forwarded-Port',
        'Front-End-Https',
        'X-Rewrite-Url',
        // ...and Cloudflare's, so they are stripped from anyone who isn't Cloudflare.
        'CF-Connecting-IP',
        'CF-IPCountry',
        'CF-Visitor',
        'CF-Ray',
    ])
    ->trustedHosts([
        // IPv4 — cloudflare.com/ips-v4
        '173.245.48.0/20',
        '103.21.244.0/22',
        '103.22.200.0/22',
        '103.31.4.0/22',
        '141.101.64.0/18',
        '108.162.192.0/18',
        '190.93.240.0/20',
        '188.114.96.0/20',
        '197.234.240.0/22',
        '198.41.128.0/17',
        '162.158.0.0/15',
        '104.16.0.0/13',
        '104.24.0.0/14',
        '172.64.0.0/13',
        '131.0.72.0/22',
        // IPv6 — cloudflare.com/ips-v6
        '2400:cb00::/32',
        '2606:4700::/32',
        '2803:f800::/32',
        '2405:b500::/32',
        '2405:8100::/32',
        '2a06:98c0::/29',
        '2c0f:f248::/32',
    ])
;


// DEV ONLY. Craft's own default is 16MB, and it's the only thing capping uploads here:
// PHP is already at 100M (upload_max_filesize / post_max_size) and DDEV's nginx sets
// client_max_body_size 0, so raising this alone is what moves the limit.
//
// Left at Craft's default everywhere else on purpose — production's PHP and web server
// have their own ceilings, and a Craft limit above them fails at the web server with a
// generic error instead of Craft's own "file is too large" message. Raise those first
// if this needs to go live.
//
// Same environment test as config/vite.php, which is how this project already tells
// dev from the rest.
if (App::env('CRAFT_ENVIRONMENT') === 'dev') {
    $config->maxUploadFileSize('50M');
}

return $config;
