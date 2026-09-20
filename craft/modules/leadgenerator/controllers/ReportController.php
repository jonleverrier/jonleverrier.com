<?php

namespace modules\leadgenerator\controllers;

use Craft;
use craft\web\Controller;
use modules\leadgenerator\LeadGenerator;
use yii\web\NotFoundHttpException;
use yii\web\Response;

/**
 * The report, as a web page.
 *
 * THE PDF IS A PRINTED WEB PAGE, which is why this exists. Designing a report as a string
 * of HTML inside a JS file means no preview, no design tokens and a re-render for every
 * change; designing it as a Twig template means the site's own fonts, colours and type
 * scale are simply there, and the loop is a browser refresh. Playwright then navigates
 * here and prints what it finds.
 *
 * IT READS report.json AND COMPUTES NOTHING. The percentages come from lib/surface.mjs,
 * over a partition asserted to tile the page exactly. A PHP class adding the same areas up
 * a second time would be a second implementation of one number, and the first anyone would
 * know it had drifted is a prospect asking which is right.
 *
 * WHO MAY SEE IT. A lead's report is about a stranger's site and sits beside their email,
 * so this is not public: either a logged-in user who can see the control panel, or a
 * request carrying a token this application signed. Playwright gets the second, minted by
 * the job for one render.
 */
class ReportController extends Controller
{
    protected int|bool|array $allowAnonymous = true;

    /** The report for an entry, as HTML. */
    public function actionView(int $entry): Response
    {
        $this->authorise($entry);
        $record = Craft::$app->getEntries()->getEntryById($entry);
        $data = LeadGenerator::getInstance()->audit->reportData($entry);
        if (!$record || !$data) {
            throw new NotFoundHttpException('no report for that entry — has the audit run?');
        }

        // Rendered as a SITE template, not a CP one: it has to reach the site's own CSS,
        // and a CP-rendered template resolves paths against the control panel.
        return $this->renderTemplate('_views/report/audit', [
            'entry' => $record,
            'report' => $data,
            // The annotated page, addressed through this controller because the audit
            // directory is in storage and deliberately not under the webroot.
            'annotated' => $this->artefactUrl($entry, 'debug.png'),
        ], \craft\web\View::TEMPLATE_MODE_SITE);
    }

    /**
     * One file out of an entry's audit directory.
     *
     * The annotated screenshot is 14MB on a long page and lives in storage, which is not
     * web-accessible and should not be: it is a picture of somebody else's site sitting
     * next to their email address. Serving it through here keeps the same answer to "who
     * may see this" as the report itself.
     */
    public function actionArtefact(int $entry, string $name): Response
    {
        $this->authorise($entry);
        $path = LeadGenerator::getInstance()->audit->artefact($entry, $name);
        if (!$path) {
            throw new NotFoundHttpException('no such artefact');
        }

        return Craft::$app->getResponse()->sendFile($path, null, ['inline' => true]);
    }

    /**
     * A signed token for one entry, so the renderer can fetch what a person can.
     *
     * Craft's own security component signs it, so it cannot be forged or edited to name a
     * different entry; the entry id is inside the signature rather than beside it.
     */
    public static function token(int $entryId): string
    {
        return Craft::$app->getSecurity()->hashData((string) $entryId);
    }

    /** A CP user, or a token this application signed for THIS entry. Nothing else. */
    private function authorise(int $entryId): void
    {
        $user = Craft::$app->getUser()->getIdentity();
        if ($user && $user->can('accessCp')) {
            return;
        }
        $signed = (string) $this->request->getQueryParam('t', '');
        $claimed = Craft::$app->getSecurity()->validateData($signed);
        if ($claimed !== false && (int) $claimed === $entryId) {
            return;
        }

        throw new NotFoundHttpException('not found');
    }

    private function artefactUrl(int $entryId, string $name): string
    {
        return \craft\helpers\UrlHelper::actionUrl('leadgenerator/report/artefact', [
            'entry' => $entryId,
            'name' => $name,
            't' => self::token($entryId),
        ]);
    }
}
