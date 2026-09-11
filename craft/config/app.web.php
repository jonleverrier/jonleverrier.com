<?php
/**
 * Yii Application Config — WEB REQUESTS ONLY
 *
 * Merged on top of config/app.php for web requests (bootstrap.php:282). Components
 * that only exist for a web request belong here; a 'web' key inside app.php does NOT
 * work, because the top-level keys there are environment names.
 *
 * @link https://craftcms.com/docs/5.x/reference/config/app.html
 */

use craft\helpers\App;
use modules\frontend\cache\ResilientRedisCache;

return [
    '*' => [
        'components' => [
            /**
             * SESSION — Redis, so a deploy doesn't orphan every live conversation.
             *
             * Every Jonson cache key hangs off the session id (see AskController), and
             * sessions were files under PHP's own save_path: clear that directory —
             * a release, a container rebuild, a tidy-up cron — and every conversation
             * in flight loses the thread it belongs to.
             *
             * A DIFFERENT REDIS DATABASE from the cache, on purpose. `php craft
             * clear-caches/all` flushes the cache's database, and sharing one would
             * sign every visitor out as a side effect of clearing a template cache.
             *
             * PROBED rather than wrapped, which is the opposite of what the cache
             * does, because the two fail differently. A cache call can be retried
             * against another backend mid-request; a session handler cannot — storage
             * is chosen when the session opens and everything afterwards assumes it.
             * So the choice is made up front: no PING, no Redis, file sessions for this
             * request. The cost is one round trip on requests that actually open a
             * session, which for an anonymous front-end visitor is only the Jonson
             * endpoint — Craft doesn't open sessions for other front-end requests. The
             * gap this leaves, Redis dying AFTER the probe, is a far narrower window
             * than the one the cache has to cover.
             *
             * Everything else about the session — Craft's own class, SessionBehavior,
             * the cookie config — comes from App::sessionConfig() untouched. Only where
             * the data lives changes.
             */
            'session' => static function() {
                $config = App::sessionConfig();
                $redis = ResilientRedisCache::connectionConfig(
                    (int) (App::env('REDIS_SESSION_DATABASE') ?: 1),
                );

                if ($redis !== null && ResilientRedisCache::canReach($redis)) {
                    $config['class'] = yii\redis\Session::class;
                    $config['redis'] = $redis;
                }

                return Craft::createObject($config);
            },
        ],
    ],
];
