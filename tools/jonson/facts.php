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
        // What the study says — Jonson describes the work from these, so the judge must
        // read them too ("adopted by the Government of Jersey" is in Vaiie Identify's).
        'summary' => $s['summary'],
        'notes' => $s['jonsonSummary'],
    ], $jonson->findContext->caseStudies()),
    // Who said what about Jon — "Oliver Atkinson, who ran Urban.co.uk" is a fact here.
    'testimonials' => array_map(static fn(Entry $t) => [
        'name' => trim((string) ($t->personName ?? '')),
        'role' => trim((string) ($t->jobTitle ?? '')),
        'company' => \modules\frontend\helpers\Testimonials::company($t),
        'quote' => trim(strip_tags((string) ($t->blockquote ?? ''))),
    ], Entry::find()->section('testimonials')->status(null)->all()),
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
    // How long the longest relationships have run, as Jon stated it (2026-10-02). Test
    // truth only — it lets the judge accept these if Jonson says them; it is not shown to
    // Jonson and not written into Jon's own content.
    'relationships' => 'The White Paper Conference Company: over a decade, ongoing. Urban.co.uk: around five years. Vaiie: around five years. Many of his early clients were Jersey-based. His startup work is mostly with pre-seed and seed-stage startups.',
    // What Jonson itself reads about Jon — his personality text and his notes — so the
    // judge doesn't call true things invented ("pre-seed startups", his side projects).
    'personality' => trim(strip_tags((string) (Entry::find()->section('personality')->one()?->personality ?? ''))),
    'notes' => array_map(static fn(Entry $n) => [
        'title' => $n->title,
        'summary' => trim(strip_tags((string) ($n->summary ?? ''))),
        'memory' => trim(strip_tags((string) ($n->jonsonSummary ?? ''))),
    ], Entry::find()->section('notes')->status('live')->all()),
    'ctas' => $ctas,
    'vips' => $doors,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
