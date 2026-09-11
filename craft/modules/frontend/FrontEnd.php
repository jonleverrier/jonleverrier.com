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
                    // Deliberately empty for now — the policy this module arrived with
                    // belonged to another site (HubSpot, LinkedIn, Bing) and none of it
                    // applies here. Fill this in when the third parties are known; the
                    // header isn't sent while it's blank.
                    $csp = "";

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
