<?php

namespace modules\frontend\cache;

use Craft;
use craft\helpers\App;
use yii\caching\FileCache;
use yii\redis\Connection;
use yii\redis\Cache as RedisCache;

/**
 * RESILIENT REDIS CACHE
 *
 * Craft's `cache` component, on Redis, that does not take the site down with it when
 * Redis goes away.
 *
 * Everything Jonson knows about a visitor mid-conversation lives in this component —
 * the history fed to the model, the answer bundles, the once-per-conversation gating,
 * the rate counter (see AskController). Craft itself leans on it for element queries,
 * template caches and more. An unhandled connection error in here is a 500 on every
 * page, not a slow one, which is why a plain `yii\redis\Cache` was not an acceptable
 * answer on its own.
 *
 * HOW IT DEGRADES. The six protected primitives below are the entire surface
 * `yii\caching\Cache` uses to reach its backend, so wrapping them covers get(), set(),
 * add(), delete(), flush(), multi-get, getOrSet() and every other public method for
 * free. Each one tries Redis; on any Throwable the component latches into a degraded
 * state and re-runs the call against a FileCache — the exact backend the site used
 * before Redis existed, so the fallback is a known-good path rather than a new one.
 *
 * The latch is per REQUEST, not per call. Once Redis has failed, every later call in
 * that request goes straight to the file cache: retrying a dead socket six times a
 * page just moves the outage from "500" to "unusably slow", and the connect timeout is
 * paid on each attempt. The next request starts hopeful again, so recovery needs no
 * intervention.
 *
 * WHAT IT COSTS. A cache warmed in Redis and then read from files looks EMPTY, so a
 * failover is a cold cache, not stale data — pages rebuild, conversations lose their
 * history and start fresh. That is the intended trade: a visitor who has to re-ask a
 * question beats a site that is down. It also means the two stores drift apart while
 * degraded and Redis is authoritative again the moment it returns; nothing here tries
 * to reconcile them, because a cache with a TTL does not need reconciling.
 */
class ResilientRedisCache extends RedisCache
{
    /**
     * Set the moment Redis first fails, and never unset within the request. See the
     * class note: re-probing a dead socket costs a connect timeout per call.
     */
    private bool $degraded = false;

    private ?FileCache $files = null;

    /**
     * The fallback, configured exactly as Craft configures its own default cache —
     * same path, same key prefix, same file modes — so a degraded request is reading
     * and writing the store this site used before Redis.
     */
    private function files(): FileCache
    {
        if ($this->files === null) {
            $general = Craft::$app->getConfig()->getGeneral();
            $this->files = new FileCache([
                'keyPrefix' => $this->keyPrefix,
                'cachePath' => Craft::$app->getPath()->getCachePath(),
                'fileMode' => $general->defaultFileMode,
                'dirMode' => $general->defaultDirMode,
                'defaultDuration' => $general->cacheDuration,
            ]);
        }

        return $this->files;
    }

    /**
     * Run a call against Redis, or against the file cache once Redis has failed.
     *
     * `$onFiles` receives the FileCache and must perform the same operation on it.
     * Both callables take the cache as their argument so neither closure has to
     * re-derive the key.
     */
    private function attempt(callable $onRedis, callable $onFiles): mixed
    {
        if ($this->degraded) {
            return $onFiles($this->files());
        }

        try {
            return $onRedis();
        } catch (\Throwable $e) {
            $this->degraded = true;
            // WARNING, not error: the site is still serving. Logged once per request
            // by virtue of the latch, so an outage produces one line per request
            // rather than one per cache call.
            Craft::warning(
                '[cache] Redis unavailable, falling back to the file cache for this request: ' . $e->getMessage(),
                __METHOD__,
            );

            return $onFiles($this->files());
        }
    }

    /**
     * The FileCache primitives are protected, so they are reached the same way Yii
     * reaches them internally. Cleaner than duplicating Yii's key handling here, and
     * it keeps the fallback semantics identical to the real thing.
     */
    private function onFiles(FileCache $cache, string $method, array $args): mixed
    {
        $call = \Closure::bind(
            static fn(FileCache $c) => $c->$method(...$args),
            null,
            FileCache::class,
        );

        return $call($cache);
    }

    protected function getValue($key)
    {
        return $this->attempt(
            fn() => parent::getValue($key),
            fn(FileCache $c) => $this->onFiles($c, 'getValue', [$key]),
        );
    }

    protected function setValue($key, $value, $duration)
    {
        return $this->attempt(
            fn() => parent::setValue($key, $value, $duration),
            fn(FileCache $c) => $this->onFiles($c, 'setValue', [$key, $value, $duration]),
        );
    }

    protected function addValue($key, $value, $duration)
    {
        return $this->attempt(
            fn() => parent::addValue($key, $value, $duration),
            fn(FileCache $c) => $this->onFiles($c, 'addValue', [$key, $value, $duration]),
        );
    }

    protected function deleteValue($key)
    {
        return $this->attempt(
            fn() => parent::deleteValue($key),
            fn(FileCache $c) => $this->onFiles($c, 'deleteValue', [$key]),
        );
    }

    protected function flushValues()
    {
        return $this->attempt(
            fn() => parent::flushValues(),
            fn(FileCache $c) => $this->onFiles($c, 'flushValues', []),
        );
    }

    protected function getValues($keys)
    {
        return $this->attempt(
            fn() => parent::getValues($keys),
            fn(FileCache $c) => $this->onFiles($c, 'getValues', [$keys]),
        );
    }

    /**
     * The multi-set. `yii\redis\Cache` overrides this with an MSET/MULTI pipeline, so
     * it reaches Redis on its own rather than looping setValue() — miss it and a single
     * `$cache->multiSet()` still throws with everything else wrapped. FileCache does NOT
     * override it, which is fine: the inherited version loops its own setValue().
     */
    protected function setValues($data, $expire)
    {
        return $this->attempt(
            fn() => parent::setValues($data, $expire),
            fn(FileCache $c) => $this->onFiles($c, 'setValues', [$data, $expire]),
        );
    }

    /**
     * PUBLIC, unlike every other method here, because `yii\redis\Cache` overrides the
     * public exists() with a direct EXISTS command instead of going through getValue().
     * That made it the one door into Redis this wrapper didn't cover.
     */
    public function exists($key)
    {
        return $this->attempt(
            fn() => parent::exists($key),
            fn(FileCache $c) => $c->exists($key),
        );
    }

    /**
     * The Redis connection config, or null when Redis isn't configured.
     *
     * Lives here rather than in config/app.php because BOTH app.php (the cache) and
     * app.web.php (the session) need it, and those are two files Craft loads
     * separately — the alternative was the same dozen lines twice, drifting apart the
     * first time a timeout was tuned.
     *
     * An empty REDIS_HOST is the switch that runs the whole site on files, exactly as
     * it did before Redis existed.
     *
     * The timeouts are deliberately short. Redis is local or same-network, so a healthy
     * connect is sub-millisecond; anything near a second means it is gone, and every
     * second spent establishing that is a second a visitor waits. One retry covers a
     * dropped idle socket — the common, recoverable case — and no more, because beyond
     * that we are only making an outage slower to notice.
     */
    public static function connectionConfig(?int $database = null): ?array
    {
        if (!App::env('REDIS_HOST')) {
            return null;
        }

        return [
            'class' => Connection::class,
            'hostname' => App::env('REDIS_HOST'),
            'port' => (int) (App::env('REDIS_PORT') ?: 6379),
            'password' => App::env('REDIS_PASSWORD') ?: null,
            'database' => $database ?? (int) (App::env('REDIS_DATABASE') ?: 0),
            'connectionTimeout' => 1,
            'dataTimeout' => 1,
            'retries' => 1,
        ];
    }

    /**
     * Can Redis be reached right now? One connect and a PING, memoised per request.
     *
     * For the SESSION component, which cannot fall back once it has opened (see the
     * note in config/app.php) and so has to choose its storage up front. Static and
     * memoised because the session config closure can run more than once per request
     * and a probe per call would defeat the point of a cheap probe.
     *
     * Returns false on any failure, so an unreachable Redis, a wrong password and a
     * refused connection all land on file sessions rather than an exception.
     */
    public static function canReach(array $connection): bool
    {
        static $reachable = null;
        if ($reachable !== null) {
            return $reachable;
        }

        try {
            $probe = Craft::createObject($connection);
            $probe->open();
            $reachable = $probe->executeCommand('PING') !== false;
            $probe->close();
        } catch (\Throwable $e) {
            Craft::warning('[session] Redis unreachable, using file sessions: ' . $e->getMessage(), __METHOD__);
            $reachable = false;
        }

        return $reachable;
    }

    /**
     * Is this request being served from Redis, or has it already fallen back?
     *
     * Read by AskController's rate limiter, which uses an atomic INCR when Redis is
     * genuinely behind the component and a read-modify-write when it isn't.
     */
    public function isDegraded(): bool
    {
        return $this->degraded;
    }

    /**
     * One atomic increment, returning the new value — or null when Redis isn't
     * available, so the caller can fall back to its own get/set.
     *
     * Exposed because `yii\caching\Cache` has no atomic increment: every counter
     * built on get()-then-set() is a read-modify-write, and two requests landing
     * together both read N and both write N+1. INCR closes that.
     *
     * `$ttl` is applied with EXPIRE only when the counter is created (INCR returned
     * 1), so the window runs from the first counted event and a later increment
     * doesn't push the expiry out.
     */
    public function increment(string $key, int $ttl): ?int
    {
        if ($this->degraded) {
            return null;
        }

        try {
            $redisKey = $this->buildKey($key);
            $count = (int) $this->redis->executeCommand('INCR', [$redisKey]);
            if ($count === 1) {
                $this->redis->executeCommand('EXPIRE', [$redisKey, $ttl]);
            }

            return $count;
        } catch (\Throwable $e) {
            $this->degraded = true;
            Craft::warning('[cache] Redis INCR failed, counter falling back: ' . $e->getMessage(), __METHOD__);

            return null;
        }
    }
}
