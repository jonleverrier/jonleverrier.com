<?php

namespace modules\jonson;

use Craft;
use craft\elements\Entry;
use craft\events\ModelEvent;
use craft\events\RegisterComponentTypesEvent;
use craft\events\RegisterTemplateRootsEvent;
use craft\events\RegisterUrlRulesEvent;
use craft\helpers\Queue;
use craft\services\Dashboard;
use craft\web\UrlManager;
use craft\web\View;
use modules\jonson\jobs\GenerateNoteMemory;
use modules\jonson\services\Analytics;
use modules\jonson\services\FindContext;
use modules\jonson\services\NoteMemory;
use modules\jonson\services\Persona;
use modules\jonson\services\Spotify;
use modules\jonson\services\Vip;
use modules\jonson\widgets\Insights;
use yii\base\Event;
use yii\base\Module as BaseModule;

/**
 * Jonson — the Claude-powered "ask me anything" assistant.
 *
 * @property-read Analytics $analytics
 * @property-read Persona $persona
 * @property-read FindContext $findContext
 * @property-read Spotify $spotify
 * @property-read NoteMemory $noteMemory
 * @property-read Vip $vip
 * @method static Jonson getInstance()
 */
class Jonson extends BaseModule
{
    public function init(): void
    {
        Craft::setAlias('@modules/jonson', __DIR__);
        $this->controllerNamespace = Craft::$app->getRequest()->getIsConsoleRequest()
            ? 'modules\\jonson\\console\\controllers'
            : 'modules\\jonson\\controllers';

        parent::init();

        $this->setComponents([
            'analytics' => Analytics::class,
            'persona' => Persona::class,
            'findContext' => FindContext::class,
            'spotify' => Spotify::class,
            'noteMemory' => NoteMemory::class,
            'vip' => Vip::class,
        ]);

        // A note saved live with no memory card yet gets one written in the
        // background — see services\NoteMemory for what a card is and why. The
        // write-back saves the entry again and lands here again; needs() then
        // finds the card full and nothing is queued, so it can't loop.
        Event::on(
            Entry::class,
            Entry::EVENT_AFTER_SAVE,
            function (ModelEvent $event) {
                /** @var Entry $entry */
                $entry = $event->sender;
                if ($this->noteMemory->needs($entry) || $this->noteMemory->needsPrompts($entry)) {
                    Queue::push(new GenerateNoteMemory(['entryId' => $entry->id]));
                }
            }
        );

        // A vip entry gets its alternate slug the first time it's saved without one
        // (see services\Vip::fillAltSlug) — set before the save so it's part of it.
        Event::on(
            Entry::class,
            Entry::EVENT_BEFORE_SAVE,
            function (ModelEvent $event) {
                /** @var Entry $entry */
                $entry = $event->sender;
                $this->vip->fillMainSlug($entry);
                $this->vip->fillAltSlug($entry);
            }
        );

        // The dashboard widget, and the CP template root it renders from.
        //
        // NOT guarded on getIsCpRequest(). Both events only ever fire in the CP, so the
        // guard saved nothing — and it made the widget unrenderable from the console,
        // which is the only way to check the template without logging in.
        Event::on(
            View::class,
            View::EVENT_REGISTER_CP_TEMPLATE_ROOTS,
            static function(RegisterTemplateRootsEvent $event) {
                $event->roots['jonson'] = __DIR__ . '/templates';
            }
        );

        Event::on(
            Dashboard::class,
            Dashboard::EVENT_REGISTER_WIDGET_TYPES,
            static function(RegisterComponentTypesEvent $event) {
                $event->types[] = Insights::class;
            }
        );

        // PRESENCE — who is on the site right now (services\Analytics).
        //
        // EVENT_AFTER_RENDER_PAGE_TEMPLATE, not a request event: it fires once per
        // actual page render, so assets never reach it, and it costs no extra round
        // trip — the visitor already asked for this page.
        //
        // EVERYTHING ELSE IS GUARDED EXPLICITLY BELOW. This comment used to claim that
        // action requests, 404s and previews never got here, and the live presence table
        // disagreed: an asset-transform action and a probe at /x were both sitting in it
        // as people. The event narrows the field; it does not do the filtering.
        Event::on(
            View::class,
            View::EVENT_AFTER_RENDER_PAGE_TEMPLATE,
            function() {
                $request = Craft::$app->getRequest();
                if (!$request->getIsSiteRequest() || $request->getIsConsoleRequest()) {
                    return;
                }

                // getIsSiteRequest() ONLY MEANS "NOT THE CONTROL PANEL". It was doing the
                // job the comment above claims for it — keeping the CP out — and none of
                // the rest. A front-end action request passes it happily, which is how
                // /actions/assets/generate-transform ended up in the presence table as a
                // live visitor. So the other three exclusions have to be stated.
                if ($request->getIsActionRequest()) {
                    return;
                }

                // A 404 is a page render like any other — the error template goes through
                // this same event — so a crawler probing /x counted as somebody on the
                // site. Measured, not assumed: with devMode off (as in production) the
                // presence row for a real page was overwritten by the probe.
                //
                // ASKED OF THE ERROR HANDLER, NOT THE RESPONSE. The obvious check —
                // getStatusCode() !== 200 — does nothing here: the status is still 200
                // while the template renders and only becomes 404 on the way out. The
                // error handler, by contrast, is already holding the exception it is
                // rendering a page for.
                //
                // devMode hides all of this locally, which is why it went unnoticed: with
                // devMode on, a 404 is the developer exception page, not a site template,
                // and the event never fires at all.
                if (Craft::$app->getErrorHandler()->exception !== null || $request->getIsPreview()) {
                    return;
                }

                // AND NOT JON. There is exactly one kind of logged-in user here, and it
                // is whoever is reading this dashboard: a tab left open on the live site
                // put the author into his own "who is here right now" count. VIP visitors
                // are unaffected — a VIP door is a signed cookie, not a Craft account.
                if (Craft::$app->getUser()->getIdentity() !== null) {
                    return;
                }

                // THE VISITOR MUST BE CARRYING A SESSION COOKIE ALREADY — not merely
                // be issued one by this request.
                //
                // Presence is keyed on the PHP session id, and a request that arrives
                // without the cookie gets a BRAND NEW session: a fresh id, a fresh
                // presence row. Anything that keeps no cookies — a crawler, a
                // monitoring check, curl — therefore registers as a new live visitor on
                // every single page it touches. Measured on this dev site: 20 distinct
                // tokens inside one five-minute window, from five scripted requests and
                // some iframes, reported as 20 people on the site.
                //
                // Reading $_COOKIE rather than the cookie collection because the session
                // cookie is set by PHP itself and does not carry Yii's signature, so the
                // validated collection will not see it.
                //
                // The cost is that a visitor's FIRST page view goes uncounted; they
                // appear from their second. For "who is on the site right now" that is
                // the right trade — the alternative counts every cookieless request as
                // a person and makes the number meaningless.
                $session = Craft::$app->getSession();
                if (!isset($_COOKIE[Craft::$app->getConfig()->getGeneral()->phpSessionName])) {
                    return;
                }
                $token = $session->getIsActive() ? $session->getId() : '';
                if ($token === '') {
                    return;
                }

                $this->analytics->touchPresence(
                    $token,
                    // getPathInfo() returns '' for the homepage, and Analytics::url()
                    // answers null to an empty string — so every homepage visit stored a
                    // null path. Normalised HERE rather than in that helper, because the
                    // helper also cleans originUrl/exitUrl/pageUrl, where empty means
                    // "unknown" and turning it into '/' would invent homepage visits in
                    // the turn stats.
                    $request->getPathInfo() ?: '/',
                    // Mid-conversation if a thread exists for this session — the same
                    // cache key AskController keeps the history under.
                    (bool) Craft::$app->getCache()->exists('jonson-history:' . $token),
                );
            }
        );

        // Front-end (site) routes: the ask endpoint + the one-time Spotify OAuth.
        Event::on(
            UrlManager::class,
            UrlManager::EVENT_REGISTER_SITE_URL_RULES,
            function (RegisterUrlRulesEvent $event) {
                $event->rules['jonson/ask'] = 'jonson/ask/stream';
                // The exit beacon (services\Analytics). A site route beside the ask
                // endpoint rather than an /actions/ URL, because sendBeacon fires
                // during unload and the shortest, most ordinary path is the one least
                // likely to be interfered with by a proxy or an extension.
                $event->rules['jonson/exit'] = 'jonson/exit/index';
                // The VIP door by its alternate slug. An entry's own URI (vip/{slug})
                // is matched by Craft before URL rules, so this only ever sees the
                // codes — and anything else under /vip/, which the controller 404s.
                $event->rules['vip/<token:[A-Za-z0-9_-]+>'] = 'jonson/vip/enter';
                $event->rules['jonson/spotify/connect'] = 'jonson/spotify/connect';
                $event->rules['jonson/spotify/callback'] = 'jonson/spotify/callback';
            }
        );
    }
}
