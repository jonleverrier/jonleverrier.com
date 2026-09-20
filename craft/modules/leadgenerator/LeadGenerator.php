<?php

namespace modules\leadgenerator;

use Craft;
use modules\leadgenerator\audit\services\Audit;
use modules\leadgenerator\services\FormGuard;
use yii\base\Module as BaseModule;

/**
 * LEAD GENERATOR
 *
 * The tools that take a stranger's URL and give them something worth an email address.
 *
 * ITS OWN MODULE RATHER THAN PART OF jonson, because jonson is the persona — the chat, the
 * memories, the music, the VIP doors — and a homepage audit shares none of it. The one
 * thing they have in common is that both produce leads, which is also true of the contact
 * form and does not make them the same thing.
 *
 * `leadgenerator` AND NOT `audit`, because the audit is the first tool here and not the
 * last. The Craft channel is already called Lead Generator; a second tool is one more
 * controller and one more folder beside `audit/`, and it inherits the form guard rather
 * than re-learning it.
 *
 * Controllers sit at the module root because that is where Craft routes to
 * (`actions/lead-generator/audit/submit` → `controllers\AuditController::actionSubmit`);
 * everything a single tool owns nests under its own folder.
 *
 * WHAT IT STILL BORROWS FROM jonson, deliberately: the disposable-email list, which is
 * maintained there, and `analytics->convert()`, which is the one place a chat gets tied to
 * the lead it produced. Neither is worth a second copy.
 */
class LeadGenerator extends BaseModule
{
    public function init(): void
    {
        Craft::setAlias('@modules/leadgenerator', __DIR__);
        $this->controllerNamespace = Craft::$app->getRequest()->getIsConsoleRequest()
            ? 'modules\\leadgenerator\\console\\controllers'
            : 'modules\\leadgenerator\\controllers';

        parent::init();

        $this->setComponents([
            'formGuard' => FormGuard::class,
            'audit' => Audit::class,
        ]);
    }
}
