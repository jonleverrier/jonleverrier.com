<?php

namespace modules\jonson\services;

use Craft;
use craft\helpers\App;
use GuzzleHttp\Client;
use yii\base\Component;

/**
 * Jon's music taste from Spotify — his top artists + their genres — used as
 * personality/tone background for the persona (and, later, a small display).
 *
 * Auth is a one-time OAuth grant (scope user-top-read) done via SpotifyController;
 * after that the stored refresh token lets the server mint access tokens forever.
 * Credentials live in env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
 * SPOTIFY_REFRESH_TOKEN. Everything is cached (taste for a day — it barely
 * changes; the access token for its ~hour lifetime) and every failure degrades
 * to an empty result, so an outage or missing config simply omits the music
 * context rather than breaking an answer.
 */
class Spotify extends Component
{
    private const TOKEN_URL = 'https://accounts.spotify.com/api/token';
    private const API = 'https://api.spotify.com/v1';
    private const TASTE_KEY = 'jonson-spotify-taste';
    private const TASTE_TTL = 86400;   // 24h — taste is slow-moving
    private const TOKEN_KEY = 'jonson-spotify-token';
    private const TOKEN_TTL = 3300;    // ~55m, under the 1h access-token life
    private const ARTIST_LIMIT = 20;
    private const GENRE_LIMIT = 8;

    /** True once the three env credentials are present. */
    public function isConfigured(): bool
    {
        return App::env('SPOTIFY_CLIENT_ID')
            && App::env('SPOTIFY_CLIENT_SECRET')
            && App::env('SPOTIFY_REFRESH_TOKEN');
    }

    /**
     * { artists: [{name, image}…], genres: [top genres…] } from the top artists
     * over the given Spotify time range, or [] when unconfigured / on any
     * failure. Cached per range for a day.
     *
     * $range: 'long_term' (~all-time — defining taste, used for personality
     * background), 'medium_term' (~6 months), or 'short_term' (~last 4 weeks —
     * "what I'm into right now", used for the display).
     */
    public function taste(string $range = 'long_term'): array
    {
        if (!$this->isConfigured()) {
            return [];
        }
        if (!in_array($range, ['long_term', 'medium_term', 'short_term'], true)) {
            $range = 'long_term';
        }

        $cache = Craft::$app->getCache();
        $key = self::TASTE_KEY . ':' . $range;
        $cached = $cache->get($key);
        if (is_array($cached)) {
            return $cached;
        }

        $taste = $this->fetchTaste($range);
        if ($taste) {
            $cache->set($key, $taste, self::TASTE_TTL);
        }

        return $taste;
    }

    private function fetchTaste(string $range): array
    {
        try {
            $token = $this->accessToken();
            if ($token === null) {
                return [];
            }

            $client = new Client(['timeout' => 15, 'http_errors' => false]);
            $res = $client->get(self::API . '/me/top/artists', [
                'headers' => ['Authorization' => 'Bearer ' . $token],
                'query' => ['time_range' => $range, 'limit' => self::ARTIST_LIMIT],
            ]);
            if ($res->getStatusCode() !== 200) {
                return [];
            }

            $data = json_decode((string) $res->getBody(), true);
            $artists = [];
            $genreCounts = [];
            foreach (($data['items'] ?? []) as $artist) {
                $name = trim((string) ($artist['name'] ?? ''));
                if ($name === '') {
                    continue;
                }
                // Images are largest-first; take a ~mid size for the display.
                $images = $artist['images'] ?? [];
                $image = $images[1]['url'] ?? $images[0]['url'] ?? null;
                $artists[] = ['name' => $name, 'image' => $image];

                foreach (($artist['genres'] ?? []) as $genre) {
                    $genre = trim((string) $genre);
                    if ($genre !== '') {
                        $genreCounts[$genre] = ($genreCounts[$genre] ?? 0) + 1;
                    }
                }
            }

            if (!$artists) {
                return [];
            }

            arsort($genreCounts); // most-common genres first
            return [
                'artists' => $artists,
                'genres' => array_slice(array_keys($genreCounts), 0, self::GENRE_LIMIT),
            ];
        } catch (\Throwable $e) {
            Craft::error('[jonson] spotify taste: ' . $e->getMessage(), __METHOD__);
            return [];
        }
    }

    /** A valid access token (cached for its life), or null on failure. */
    private function accessToken(): ?string
    {
        $cache = Craft::$app->getCache();
        $cached = $cache->get(self::TOKEN_KEY);
        if (is_string($cached) && $cached !== '') {
            return $cached;
        }

        try {
            $client = new Client(['timeout' => 15, 'http_errors' => false]);
            $res = $client->post(self::TOKEN_URL, [
                'headers' => [
                    'Authorization' => 'Basic ' . base64_encode(
                        App::env('SPOTIFY_CLIENT_ID') . ':' . App::env('SPOTIFY_CLIENT_SECRET')
                    ),
                ],
                'form_params' => [
                    'grant_type' => 'refresh_token',
                    'refresh_token' => App::env('SPOTIFY_REFRESH_TOKEN'),
                ],
            ]);
            if ($res->getStatusCode() !== 200) {
                Craft::error('[jonson] spotify token: HTTP ' . $res->getStatusCode() . ' ' . (string) $res->getBody(), __METHOD__);
                return null;
            }

            $data = json_decode((string) $res->getBody(), true);
            $token = $data['access_token'] ?? null;
            if (is_string($token) && $token !== '') {
                $cache->set(self::TOKEN_KEY, $token, self::TOKEN_TTL);
                return $token;
            }
        } catch (\Throwable $e) {
            Craft::error('[jonson] spotify token: ' . $e->getMessage(), __METHOD__);
        }

        return null;
    }
}
