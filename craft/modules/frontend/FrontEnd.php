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
                        // The contact panel's "request a call back" step embeds Cal.com
                        // (see _components/contact-panel). Without this the frame falls
                        // back to default-src 'self' and the browser refuses it — and it
                        // refuses it SILENTLY as far as the panel is concerned: the step
                        // slides in on an empty box, because nothing in our code fails.
                        //
                        // frame-src and not child-src: child-src is the deprecated
                        // spelling and covers workers too, which this has no business
                        // widening.
                        //
                        // Both hosts, because the link and the embed are not the same
                        // one: cal.com/<user>/<event> is what the CMS holds and what the
                        // CTA points at elsewhere on the site, while the frame Cal opens
                        // is on app.cal.com. No wildcard — these two are the whole of it.
                        //
                        // The framed document is its own browsing context with its own
                        // policy, so connect-src, img-src and the rest still describe OUR
                        // page only and stay as they are. script-src is the exception,
                        // and it is below: Cal's embed.js runs in our page, not theirs.
                        "frame-src https://cal.com https://app.cal.com",
                        "style-src 'self' 'unsafe-inline'",
                        // app.cal.com: the contact panel's booking step loads Cal's
                        // embed.js into THIS page (contact-panel.js appends it on the
                        // first press of the CTA — never before, so a visitor who does
                        // not book never fetches it). It is the one third-party script
                        // the site runs, and the only reason script-src names a host.
                        "script-src 'self' 'unsafe-inline' https://app.cal.com",
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
