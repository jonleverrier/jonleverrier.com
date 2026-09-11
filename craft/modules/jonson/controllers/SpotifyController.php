<?php

namespace modules\jonson\controllers;

use Craft;
use craft\helpers\App;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use GuzzleHttp\Client;
use yii\web\Response;

/**
 * One-time Spotify OAuth for the music-taste feature. Admin-only.
 *
 * Visit /jonson/spotify/connect while logged into the control panel: it sends
 * you to Spotify to approve `user-top-read`, Spotify redirects back to
 * /jonson/spotify/callback, and we print the long-lived refresh token to paste
 * into your env (SPOTIFY_REFRESH_TOKEN). After that the Spotify service refreshes
 * access tokens on its own — you never need to do this again.
 */
class SpotifyController extends Controller
{
    private const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
    private const TOKEN_URL = 'https://accounts.spotify.com/api/token';

    /**
     * The redirect URI — must EXACTLY match one registered in the Spotify app.
     * Defaults to siteUrl() (i.e. PRIMARY_SITE_URL + the callback path), but can
     * be pinned via SPOTIFY_REDIRECT_URI if Spotify won't accept that host (e.g.
     * a .local domain) and you'd rather authorize against a public/prod URL.
     */
    private function redirectUri(): string
    {
        return App::env('SPOTIFY_REDIRECT_URI') ?: UrlHelper::siteUrl('jonson/spotify/callback');
    }

    public function actionConnect(): Response
    {
        $this->requireAdmin();

        $clientId = App::env('SPOTIFY_CLIENT_ID');
        if (!$clientId) {
            return $this->text("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your env first.");
        }

        $url = self::AUTHORIZE_URL . '?' . http_build_query([
            'client_id' => $clientId,
            'response_type' => 'code',
            'redirect_uri' => $this->redirectUri(),
            'scope' => 'user-top-read',
            'show_dialog' => 'true',
        ]);

        return $this->redirect($url);
    }

    public function actionCallback(): Response
    {
        $this->requireAdmin();

        $request = Craft::$app->getRequest();
        $code = $request->getQueryParam('code');
        if (!$code) {
            return $this->text('No authorization code returned. ' . (string) $request->getQueryParam('error'));
        }

        $client = new Client(['timeout' => 15, 'http_errors' => false]);
        $res = $client->post(self::TOKEN_URL, [
            'headers' => [
                'Authorization' => 'Basic ' . base64_encode(
                    App::env('SPOTIFY_CLIENT_ID') . ':' . App::env('SPOTIFY_CLIENT_SECRET')
                ),
            ],
            'form_params' => [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'redirect_uri' => $this->redirectUri(),
            ],
        ]);

        $data = json_decode((string) $res->getBody(), true);
        $refresh = $data['refresh_token'] ?? null;
        if (!$refresh) {
            return $this->text("Couldn't get a refresh token.\n\nSpotify said:\n" . (string) $res->getBody());
        }

        return $this->text(
            "✓ Connected.\n\nAdd this line to your env (alongside KEY_ANTHROPIC_API), then run "
            . "`ddev craft clear-caches/all`:\n\nSPOTIFY_REFRESH_TOKEN=\"" . $refresh . "\"\n\n"
            . "That's a one-time step — you won't need to do this again."
        );
    }

    private function text(string $body): Response
    {
        $response = Craft::$app->getResponse();
        $response->format = Response::FORMAT_RAW;
        $response->getHeaders()->set('Content-Type', 'text/plain; charset=utf-8');
        $response->content = $body;

        return $response;
    }
}
