<?php
/**
 * Ground truth for the Jonson tests, straight from the CMS — so the checks compare
 * Jonson against what is actually true, and grow with the content (no per-client or
 * per-study lists kept by hand).
 *
 *   ddev exec "php tools/jonson/facts.php"                 JSON: clients, studies,
 *                                                            sectors, CTAs, VIP doors
 *   ddev exec "php tools/jonson/facts.php set-hits <slug> <n>"   reset a door's counter
 *                                                            (vip.mjs restores it)
 *
 * Read by run.mjs (the invented-claims judge) and vip.mjs (purpose CTAs, hit counting).
 */

use craft\elements\Entry;
use modules\jonson\Jonson;

require dirname(__DIR__, 2) . '/craft/bootstrap.php';
$app = require CRAFT_VENDOR_PATH . '/craftcms/cms/bootstrap/console.php';

$jonson = Jonson::getInstance();
$vip = $jonson->vip;

if (($argv[1] ?? '') === 'set-hits') {
    $entry = Entry::find()->section('vip')->slug($argv[2] ?? '')->status(null)->one();
    if (!$entry) {
        fwrite(STDERR, "no vip entry {$argv[2]}\n");
        exit(1);
    }
    $entry->setFieldValue(\modules\jonson\services\Vip::HITS_FIELD, (int) ($argv[3] ?? 0));
    Craft::$app->getElements()->saveElement($entry, false, false, false);
    echo "ok\n";
    exit(0);
}

$ctas = [];
foreach (Entry::find()->section('globals')->one()?->ctas?->all() ?? [] as $cta) {
    $purposes = [];
    foreach ($cta->purposeOptions ?? [] as $option) {
        if (trim((string) $option->value) !== '') {
            $purposes[] = trim((string) $option->value);
        }
    }
    $ctas[] = ['title' => trim((string) $cta->title), 'purposes' => $purposes];
}

$doors = [];
foreach (Entry::find()->section('vip')->status('live')->all() as $entry) {
    $doors[] = [
        'slug' => $entry->slug,
        'purpose' => $vip->purpose($entry),
        'hits' => (int) ($entry->{\modules\jonson\services\Vip::HITS_FIELD} ?? 0),
    ];
}

echo json_encode([
    'clients' => $jonson->findContext->clientWork(),
    'studies' => array_map(static fn(array $s) => [
        'slug' => $s['slug'],
        'client' => $s['client'],
        'title' => $s['title'],
        'sectors' => $s['sectors'],
    ], $jonson->findContext->caseStudies()),
    'sectors' => $jonson->findContext->sectors(),
    // Employers and roles — Jonson may truthfully say "in-house at an international bank".
    'cv' => $jonson->findContext->curriculumVitae(),
    // Who Jon says he works with and how — the About page and "How I can help" (the
    // methodology single), as plain text: Jonson draws on both, so the invention judge
    // must too, or "agencies" and "startups" read as made up.
    'about' => (static function (): string {
        $about = Entry::find()->section('about')->status('live')->one();
        $text = $about ? strip_tags((string) ($about->content ?? '')) . ' ' . strip_tags((string) ($about->summary ?? '')) : '';
        foreach ($about?->caseContent?->all() ?? [] as $block) {
            $text .= ' ' . strip_tags((string) ($block->content ?? ''));
        }
        return trim((string) preg_replace('/\s+/', ' ', $text));
    })(),
    'howICanHelp' => $jonson->findContext->methodology(),
    'ctas' => $ctas,
    'vips' => $doors,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
