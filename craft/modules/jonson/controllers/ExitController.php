<?php

namespace modules\jonson\controllers;

use Craft;
use craft\web\Controller;
use modules\jonson\Jonson;
use yii\web\Response;

/**
 * The exit beacon — where a conversation ended, and whether it ended by going
 * somewhere (build/js/components/jonson-exit.js).
 *
 * Its own controller rather than an action on AskController, because it shares nothing
 * with that one: no streaming, no model, no session work, no rate ceiling. It is a
 * single UPDATE on a row that already exists.
 *
 * CSRF IS OFF, deliberately. `navigator.sendBeacon` fires while the page is unloading
 * and cannot read a token out of the DOM reliably at that point — and a CSRF token
 * would buy nothing here anyway: the worst a forged request can do is write a path
 * into the exit column of a visit id the forger would have to already know. There is
 * nothing to steal and nothing to elevate. Everything written is normalised to a
 * same-site path by the Analytics service before it lands.
 */
class ExitController extends Controller
{
    protected int|bool|array $allowAnonymous = true;

    public $enableCsrfValidation = false;

    public function actionIndex(): Response
    {
        $this->requirePostRequest();

        $sid = (string) $this->request->getBodyParam('sid', '');
        $from = (string) $this->request->getBodyParam('from', '');
        $to = (string) $this->request->getBodyParam('to', '');

        if ($sid !== '') {
            Jonson::getInstance()->analytics->recordExit(
                $sid,
                $from !== '' ? $from : null,
                // Null, not an empty string: "we never saw where they went" and "they
                // went nowhere" are the same fact, and it is the common one — most
                // conversations end with a closed tab.
                $to !== '' ? $to : null,
            );
        }

        // 204. A beacon discards the body and nobody is waiting for this; sending
        // anything back is bytes spent on a page that has already gone.
        $this->response->setStatusCode(204);

        return $this->response;
    }
}
