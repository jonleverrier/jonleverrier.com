<?php

namespace modules\frontend;

use Craft;
use craft\helpers\App;
use craft\web\twig\variables\CraftVariable;
use modules\frontend\variables\FrontEndVariable;
use yii\base\Event;
use yii\base\Module as BaseModule;

/**
 * FrontEnd module
 *
 * @method static FrontEnd getInstance()
 */
class FrontEnd extends BaseModule
{
    public function init(): void
    {
        Craft::setAlias('@modules/frontend', __DIR__);

        // Set the controllerNamespace based on whether this is a console or web request
        if (Craft::$app->request->isConsoleRequest) {
            $this->controllerNamespace = 'modules\\frontend\\console\\controllers';
        } else {
            $this->controllerNamespace = 'modules\\frontend\\controllers';
        }

        parent::init();

        // Defer most setup tasks until Craft is fully initialized
        Craft::$app->onInit(function() {
            $this->attachEventHandlers();

            Event::on(
                CraftVariable::class,
                CraftVariable::EVENT_INIT,
                function (Event $event) {
                    $variable = $event->sender;
                    $variable->set('frontend', FrontEndVariable::class);
                }
            );

            // If this is not a CP request or a console request and a user is not logged in
            // Set CSP policy
            if (App::env('CRAFT_ENVIRONMENT') !== 'dev') {
                if (!Craft::$app->request->isCpRequest && !Craft::$app->getUser()->getIdentity() && !Craft::$app->request->isConsoleRequest) {
                    // CONTENT SECURITY POLICY — front end only.
                    //
                    // The guard above is the important half: never on a CP request,
                    // never for a signed-in user (so live preview and the editor's own
                    // tooling are untouched), never on the console, never in dev.
                    //
                    // ONE third party, and it is not the obvious one. Spotify and the
                    // Anthropic API are both called SERVER-side — Guzzle in
                    // AskController, the refresh-token flow in services/Spotify.php — so
                    // the browser never talks to either and neither belongs in
                    // connect-src. What the browser DOES fetch is the artist artwork the
                    // music strip hotlinks straight from Spotify's CDN
                    // (_components/music.twig renders <img src="{{ a.image }}">), which
                    // is why i.scdn.co appears in img-src and nowhere else. Adding
                    // api.spotify.com or api.anthropic.com would widen the policy to
                    // cover requests that are never made.
                    //
                    // 'unsafe-inline' IN script-src IS THE BUILD TOOL'S, NOT THE SITE'S.
                    // Measured across seven pages, removing it produced 21 inline-script
                    // and 14 inline-handler violations, and every one traces to
                    // nystudio107/craft-vite: the async-CSS pattern's
                    // onload="this.media='all'" and the plugin's own
                    // vite-script-loaded onload. None of it is hand-written, so none of
                    // it can be moved to a nonce without forking the plugin.
                    //
                    // What still holds with it in place: no third-party script, style,
                    // frame, font or connection can load at all, which is the whole
                    // exposure for a site with no analytics, no embeds and no tag
                    // manager. And the one place attacker-shaped text reaches the DOM —
                    // the model's answer, via innerHTML in jonson-ask.js — is already
                    // closed at source: inlineMarkdown escapes &, < and > BEFORE it
                    // re-introduces <strong> and <em>, so no markup survives to need a
                    // policy in the first place.
                    //
                    // media-src is omitted deliberately: case study video is a Craft
                    // asset, so it falls back to default-src 'self' and stays correct
                    // without a line of its own.
                    //
                    // MEASURED, not assumed: zero violations across /, /about, /notes,
                    // /case-studies, /contact, a note and a case study.
                    $csp = implode('; ', [
                        "default-src 'self'",
                        "base-uri 'self'",
                        "object-src 'none'",
                        "frame-ancestors 'none'",
                        "form-action 'self'",
                        "font-src 'self'",
                        "connect-src 'self'",
                        "img-src 'self' data: https://i.scdn.co",
                        "style-src 'self' 'unsafe-inline'",
                        "script-src 'self' 'unsafe-inline'",
                        'upgrade-insecure-requests',
                    ]);

                    if ($csp !== "") {
                        Craft::$app->response->headers->add("Content-Security-Policy", $csp);
                    }

                    Craft::$app->response->headers->add("Permissions-Policy", "interest-cohort=(), camera=(), geolocation=(), microphone=()");
                }
            }

        });
    }

    private function attachEventHandlers(): void
    {
        // Register event handlers here ...
        // (see https://craftcms.com/docs/4.x/extend/events.html to get started)
    }
}
