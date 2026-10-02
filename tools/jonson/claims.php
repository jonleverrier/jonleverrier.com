<?php
/**
 * Replays every answer the suite has stored through ClaimCheck — free, no API calls —
 * against the system prompt Jonson reads today. Proves the check catches the bad ones
 * and leaves the good ones alone (every flag here would cost a visitor a rewrite).
 *
 *   ddev exec "php tools/jonson/claims.php"            flagged answers + totals
 *   ddev exec "php tools/jonson/claims.php 2026-10-02"  only result files from that day
 *   … claims.php -v                                     also print each flagged answer
 */

use modules\jonson\Jonson;
use modules\jonson\controllers\AskController;

require dirname(__DIR__, 2) . '/craft/bootstrap.php';
$app = require CRAFT_VENDOR_PATH . '/craftcms/cms/bootstrap/console.php';

$jonson = Jonson::getInstance();
$ask = new AskController('ask', $jonson);
$context = (new ReflectionMethod($ask, 'claimContext'))->invoke($ask);
$employers = $jonson->findContext->employers();
$clients = $jonson->findContext->workNames();

// The VIP turns had the visitor's own note in their context ("at Hiizzy"); the replay
// doesn't know which door a run used, so it reads them all.
foreach (\craft\elements\Entry::find()->section('vip')->status(null)->all() as $door) {
    $context .= "\n" . $door->title . "\n" . $jonson->vip->note($door);
}

// Lines the check must catch, and true ones it must leave alone. A miss here fails the
// replay outright, whatever the stored answers say.
$mustFlag = [
    "I've worked with Apple and Lloyds over the years.",
    'Clients like Nike, HSBC International and Vaiie.',
    'I spent time in-house at HSBC International and Lloyds Bank International.',
    'I was employed by Feel Unique for three years.',
    'Banking clients like Lloyds and Barclays.',
    'I designed the new app for Spotify.',
];
$mustPass = [
    'I spent time in-house at HSBC International, and did conversion work for Lloyds Bank International.',
    'Banking clients like Lloyds and HSBC International, telecoms with Sure, beauty with Feel Unique.',
    "Yes, and it's a relationship I'm proud of — I was brought in-house at Vaiie as Head of Design.",
    "There's Lloyds Bank International, Jersey Post and Government of Jersey in there too.",
    "White Paper are a UK CPD conference provider I've worked with for over a decade.",
    'I shoot on a Leica, and I live in Bordeaux.',
    'I worked at E-scape Interactive, then co-founded Hive Creative.',
];
$selfFails = 0;
foreach ($mustFlag as $line) {
    if (!$jonson->claimCheck->problems($line, $context, $employers, $clients)) {
        $selfFails++;
        echo "MISSED  $line\n";
    }
}
foreach ($mustPass as $line) {
    if ($p = $jonson->claimCheck->problems($line, $context, $employers, $clients)) {
        $selfFails++;
        echo "WRONGLY FLAGGED  $line\n  ", implode("\n  ", $p), "\n";
    }
}
printf("self-test: %d of %d right\n\n", count($mustFlag) + count($mustPass) - $selfFails, count($mustFlag) + count($mustPass));

$verbose = in_array('-v', $argv, true);
$only = current(array_filter(array_slice($argv, 1), static fn($a) => $a !== '-v')) ?: '';
$seen = [];
$flagged = 0;
foreach (glob(__DIR__ . '/results/*.json') as $file) {
    if ($only !== '' && !str_starts_with(basename($file), $only)) {
        continue;
    }
    $run = json_decode((string) file_get_contents($file), true);
    foreach ($run['scenarios'] ?? [] as $scenario) {
        $history = '';
        foreach ($scenario['turns'] ?? [] as $turn) {
            $answer = (string) ($turn['answer'] ?? '');
            $question = (string) ($turn['q'] ?? '');
            if ($answer !== '' && !isset($seen[$answer])) {
                $seen[$answer] = true;
                $problems = $jonson->claimCheck->problems($answer, "$context\n$history\n$question", $employers, $clients);
                if ($problems) {
                    $flagged++;
                    echo basename($file), "  ", $scenario['id'] ?? '', "\n  ", implode("\n  ", $problems), "\n";
                    if ($verbose) {
                        echo '    > ', str_replace("\n", "\n    > ", trim($answer)), "\n";
                    }
                }
            }
            $history .= "\n$question\n$answer";
        }
    }
}
printf("\n%d of %d answers flagged (%.2f%%)\n", $flagged, count($seen), count($seen) ? 100 * $flagged / count($seen) : 0);
exit($selfFails ? 1 : 0);
