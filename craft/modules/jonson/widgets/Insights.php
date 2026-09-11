<?php

namespace modules\jonson\widgets;

use Craft;
use craft\base\Widget;
use modules\jonson\Jonson;
use modules\jonson\services\Analytics;

/**
 * JONSON INSIGHTS — the dashboard widget.
 *
 * Presentation only: every number comes from services\Analytics, which owns the
 * queries. This class decides how wide it is, how far back it looks, and nothing else.
 *
 * The questions it exists to answer, in the order a person actually asks them:
 * is anyone here right now, is the assistant working, what are people asking, are the
 * suggestions any good, where do conversations end, and what is it costing.
 */
class Insights extends Widget
{
    /** How many days the figures cover. The token total ignores this — see the template. */
    public int $days = 30;

    public static function displayName(): string
    {
        return 'Jonson';
    }

    public static function icon(): ?string
    {
        return 'comments';
    }

    /**
     * Full width allowed. The per-suggestion table is the reason: offered, taken and
     * the chip's own wording side by side doesn't fit a narrow column, and that table
     * is the one panel here that changes what you'd do next.
     */
    public static function maxColspan(): ?int
    {
        return null;
    }

    public function getTitle(): ?string
    {
        return 'Jonson';
    }

    public function getSubtitle(): ?string
    {
        return 'Last ' . $this->days . ' days';
    }

    protected function defineRules(): array
    {
        return array_merge(parent::defineRules(), [
            [['days'], 'integer', 'min' => 1, 'max' => 365],
        ]);
    }

    public function getSettingsHtml(): ?string
    {
        return Craft::$app->getView()->renderTemplate('jonson/widgets/insights-settings.twig', [
            'widget' => $this,
        ]);
    }

    public function getBodyHtml(): ?string
    {
        $analytics = Jonson::getInstance()->analytics;

        return Craft::$app->getView()->renderTemplate('jonson/widgets/insights.twig', [
            // All three segments up front, so the tabs switch instantly rather than
            // fetching. Three sets of small aggregate queries on a dashboard load is a
            // fair price for that; if this ever gets expensive, the fix is an endpoint
            // per tab rather than making the default slower.
            'segments' => [
                'all' => $analytics->insights($this->days, Analytics::ALL),
                'general' => $analytics->insights($this->days, Analytics::GENERAL),
                'vips' => $analytics->insights($this->days, Analytics::VIP),
            ],
            // Read separately from the window above: presence is "right now" and has
            // nothing to do with how many days the rest of the widget covers. Not
            // segmented either — the presence table carries no VIP flag — so the same
            // figure shows on every tab.
            'presence' => $analytics->presence(),
        ]);
    }
}
