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
    protected int|bool|array $allowAnonymous = true;

    public function actionEnter(string $token): Response
    {
        $vip = Jonson::getInstance()->vip;
        $entry = $vip->findByToken($token);
        if (!$entry) {
            throw new NotFoundHttpException();
        }

        return $vip->enter($entry);
    }
}
