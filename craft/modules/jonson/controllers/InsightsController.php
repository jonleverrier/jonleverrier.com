<?php

namespace modules\jonson\controllers;

use Craft;
use craft\web\Controller;
use yii\web\Response;

/**
 * The dashboard widget's "Mark as seen" (widgets/Insights): the unanswered questions
 * listed so far are cleared from the warning until a new one happens. Per user, kept
 * in their preferences, so it survives sessions and devices. Signed-in only (no
 * allowAnonymous), POST only.
 */
class InsightsController extends Controller
{
    public const SEEN_PREF = 'jonsonIncidentsSeenAt';

    public function actionSeen(): Response
    {
        $this->requirePostRequest();
        $user = Craft::$app->getUser()->getIdentity();
        Craft::$app->getUsers()->saveUserPreferences($user, [
            self::SEEN_PREF => (new \DateTime())->format(\DateTimeInterface::ATOM),
        ]);
        $this->setSuccessFlash('Marked as seen. The warning returns if another question goes unanswered.');

        return $this->redirectToPostedUrl();
    }
}
