<?php
/**
 * Yii Application Config
 *
 * Edit this file at your own risk!
 *
 * The array returned by this file will get merged with
 * vendor/craftcms/cms/src/config/app.php and app.[web|console].php, when
 * Craft's bootstrap script is defining the configuration for the entire
 * application.
 *
 * NOTE ON THE TOP-LEVEL KEYS: '*' and the rest are ENVIRONMENT names matched against
 * CRAFT_ENVIRONMENT — they are not request types. A 'web' key in here is read as an
 * environment called "web" and silently never matches; web-only components belong in
 * app.web.php, which Craft loads separately (bootstrap.php:282). The session component
 * is over there for exactly that reason.
 *
 * @link https://craftcms.com/docs/5.x/reference/config/app.html
 */

use craft\helpers\App;
use modules\frontend\cache\ResilientRedisCache;

return [
    '*' => [
        'id' => App::env('CRAFT_APP_ID') ?: 'CraftCMS',
        'modules' => [
            'jonson' => \modules\jonson\Jonson::class,
            'frontend' => \modules\frontend\FrontEnd::class,
            'leadgenerator' => \modules\leadgenerator\LeadGenerator::class,
        ],
        'bootstrap' => ['jonson', 'frontend', 'leadgenerator'],
        'components' => [
            // Only there to set two AVIF encoder options Craft doesn't expose;
            // everything else is Craft's own service.
            'images' => modules\frontend\services\Images::class,

            /**
             * CACHE — Redis, degrading to the file cache rather than to a 500.
             *
             * Everything Jonson holds mid-conversation lives here (history, answer
             * bundles, once-gating, the rate counter), and so do Craft's own element
             * and template caches, so an unhandled Redis error would be a white screen
             * on every page rather than a slow one.
             *
             * ResilientRedisCache wraps the primitives `yii\caching\Cache` uses to
             * reach its backend and catches at CALL time, not construction: a Redis
             * that dies mid-request is handled the same as one that was never there.
             * See the class for what a failover costs (a cold cache, never stale data).
             *
             * With REDIS_HOST unset this is Craft's own default file cache, untouched.
             */
            'cache' => static function() {
                $redis = ResilientRedisCache::connectionConfig();
                if ($redis === null) {
                    return Craft::createObject(App::cacheConfig());
                }

                return Craft::createObject([
                    'class' => ResilientRedisCache::class,
                    'redis' => $redis,
                    // Craft's own prefix, so keys stay namespaced per app id exactly as
                    // they were on disk — two environments can share a Redis server
                    // without reading each other's caches.
                    'keyPrefix' => Craft::$app->id,
                    'defaultDuration' => Craft::$app->getConfig()->getGeneral()->cacheDuration,
                ]);
            },
        ],
    ],
];
