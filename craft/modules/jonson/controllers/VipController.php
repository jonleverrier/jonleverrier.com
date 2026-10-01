<?php

namespace modules\jonson\controllers;

use craft\web\Controller;
use modules\jonson\Jonson;
use yii\web\NotFoundHttpException;
use yii\web\Response;

/**
 * The VIP door by its alternate slug: /vip/{altSlug}. The entry's own slug is an
 * element URI and never reaches here (Craft matches those first — it renders
 * _views/structure/vip/default, which ends in the same Vip::enter()).
 */
class VipController extends Controller
{
    // Only the door is public. forget() is Jon's, from the CP dashboard.
    protected int|bool|array $allowAnonymous = ['enter'];

    public function actionEnter(string $token): Response
    {
        $vip = Jonson::getInstance()->vip;
        $entry = $vip->findByToken($token);
        if (!$entry) {
            throw new NotFoundHttpException();
        }

        return $vip->enter($entry);
    }

    /** Kill the VIP session on this browser — the dashboard widget's button. */
    public function actionForget(): Response
    {
        $this->requirePostRequest();
        Jonson::getInstance()->vip->forget();
        $this->setSuccessFlash('VIP session cleared on this device.');

        return $this->redirectToPostedUrl();
    }
}
