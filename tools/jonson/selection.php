<?php
/**
 * Replays tools/jonson/selection-cases.json through FindContext::caseStudies (and
 * ::testimonials for `kind: testimonial` cases, matched by person name) — the
 * deterministic half of the surfacing suite, with no API calls. A VIP case resolves
 * the door's note and passes its studies as the lead, exactly as AskController does
 * via Vip::relevantStudies (minus the once-per-conversation filter, which needs a
 * live session).
 *
 *   ddev exec "php tools/jonson/selection.php"
 *
 * Exit 1 if any case fails.
 */

require dirname(__DIR__, 2) . '/craft/bootstrap.php';
$app = require CRAFT_VENDOR_PATH . '/craftcms/cms/bootstrap/console.php';

use craft\elements\Entry;
use modules\jonson\Jonson;

$ctx = Jonson::getInstance()->findContext;
$vip = Jonson::getInstance()->vip;
$file = json_decode(file_get_contents(__DIR__ . '/selection-cases.json'), true);
$cases = $file['cases'];
$picks = $file['picks'] ?? [];

$failed = 0;
foreach ($cases as $c) {
    $lead = [];
    $entry = null;
    if (!empty($c['vip'])) {
        $entry = Entry::find()->section('vip')->slug($c['vip'])->status(null)->one();
        if (!$entry) {
            echo "FAIL  {$c['id']}: no VIP entry '{$c['vip']}'\n";
            $failed++;
            continue;
        }
        $lead = $vip->relevantStudies($entry, $picks[$c['vip']] ?? null);
    }
    // A link case: FindContext::linkStudies over an answer. `cards` = slugs whose cards
    // show under it (not linked); `linked` / `notLinked` = slugs; `text` = exact output.
    if (($c['kind'] ?? '') === 'links') {
        $out = $ctx->linkStudies($c['answer'], $c['cards'] ?? []);
        preg_match_all('~\]\(/case-study/([a-z0-9-]+)\)~', $out, $m);
        $got = $m[1];
        $fails = [];
        foreach ($c['linked'] ?? [] as $sl) {
            if (!in_array($sl, $got, true)) $fails[] = "{$sl} not linked";
        }
        foreach ($c['notLinked'] ?? [] as $sl) {
            if (in_array($sl, $got, true)) $fails[] = "{$sl} linked";
        }
        if (isset($c['text']) && $out !== $c['text']) $fails[] = 'text was: ' . $out;
        if (count($got) !== count(array_unique($got))) $fails[] = 'a study linked twice';
        $failed += $fails ? 1 : 0;
        printf("%-5s %-32s [%s]%s\n", $fails ? 'FAIL' : 'PASS', $c['id'], implode(', ', $got), $fails ? '  ← ' . implode('; ', $fails) : '');
        continue;
    }
    // A hidden-note case: what a VIP's note knows must not be said back (AskController::
    // hiddenNoteTerms → ClaimCheck::noteFindings / withoutNoteChips). `flags` = the
    // note terms the prose names (exact, in order found); `chips` = the [[next:]] block
    // left after scrubbing ('' when emptied); `said` = what the visitor typed.
    if (($c['kind'] ?? '') === 'notehidden') {
        $ask = new \modules\jonson\controllers\AskController('ask', Jonson::getInstance());
        $base = (new ReflectionMethod($ask, 'claimContext'))->invoke($ask);
        $terms = (new ReflectionMethod($ask, 'hiddenNoteTerms'))->invoke($ask, $base, $c['said'] ?? '', $entry ?? null);
        $check = Jonson::getInstance()->claimCheck;
        $flags = array_column($check->noteFindings($c['answer'], $terms), 'name');
        preg_match('/\[\[next:[^\]]*\]\]/', $check->withoutNoteChips($c['answer'], $terms), $m);
        $fails = [];
        if ($flags !== ($c['flags'] ?? [])) $fails[] = 'flagged [' . implode(', ', $flags) . ']';
        if (array_key_exists('chips', $c) && ($m[0] ?? '') !== $c['chips']) $fails[] = 'chips left: ' . ($m[0] ?? "''");
        $failed += $fails ? 1 : 0;
        printf("%-5s %-32s [%s]%s\n", $fails ? 'FAIL' : 'PASS', $c['id'], implode(', ', $flags), $fails ? '  ← ' . implode('; ', $fails) : '');
        continue;
    }
    // A VIP-fallback case: AskController::vipCardsFallback over a recorded answer, with
    // the case's door. `adds` = the [[casestudies:…]] it must add (exact), or null when
    // the answer must come back unchanged.
    if (($c['kind'] ?? '') === 'vipfallback' || ($c['kind'] ?? '') === 'vipquote') {
        $ask = new \modules\jonson\controllers\AskController('ask', Jonson::getInstance());
        $quote = $c['kind'] === 'vipquote';
        $out = (new ReflectionMethod($ask, $quote ? 'vipQuoteFallback' : 'vipCardsFallback'))->invoke($ask, $c['answer'], $entry ?? null);
        preg_match($quote ? '/(\[\[testimonial\]\])/' : '/\[\[casestudies:([^\]]*)\]\]/', $out, $m);
        $added = $out === $c['answer'] ? null : ($m[1] ?? '?');
        $want = $c['adds'] ?? null;
        $ok = $added === $want;
        $failed += $ok ? 0 : 1;
        printf("%-5s %-32s %s%s\n", $ok ? 'PASS' : 'FAIL', $c['id'], $added ?? 'unchanged', $ok ? '' : '  ← wanted ' . ($want ?? 'unchanged'));
        continue;
    }
    // A marker case: AskController::markersIn over a recorded answer — which markers
    // count as framed (render) and which are dropped. `framed` / `unframed` = handles.
    if (($c['kind'] ?? '') === 'markers') {
        $ask = new \modules\jonson\controllers\AskController('ask', Jonson::getInstance());
        $marks = (new ReflectionMethod($ask, 'markersIn'))->invoke($ask, $c['answer'], []);
        $fails = [];
        foreach ($c['framed'] ?? [] as $h) {
            if (empty($marks[$h]['framed'])) $fails[] = "{$h} dropped";
        }
        foreach ($c['unframed'] ?? [] as $h) {
            if (!empty($marks[$h]['framed'])) $fails[] = "{$h} framed";
        }
        $failed += $fails ? 1 : 0;
        $got = implode(', ', array_map(fn($h) => $h . ($marks[$h]['framed'] ? '' : ' (dropped)'), array_keys($marks)));
        printf("%-5s %-32s [%s]%s\n", $fails ? 'FAIL' : 'PASS', $c['id'], $got, $fails ? '  ← ' . implode('; ', $fails) : '');
        continue;
    }
    // A quote case: the same lead, through FindContext::testimonials, by person name.
    if (($c['kind'] ?? '') === 'testimonial') {
        $names = array_column($ctx->testimonials($c['answer'], '', array_column($lead, 'slug')), 'name');
        $fails = [];
        if (!empty($c['first']) && ($names[0] ?? null) !== $c['first']) {
            $fails[] = 'first was ' . ($names[0] ?? 'none') . ", not {$c['first']}";
        }
        foreach ($c['has'] ?? [] as $n) {
            if (!in_array($n, $names, true)) $fails[] = "missing {$n}";
        }
        foreach ($c['hasNot'] ?? [] as $n) {
            if (in_array($n, $names, true)) $fails[] = "showed {$n}";
        }
        $failed += $fails ? 1 : 0;
        printf("%-5s %-32s [%s]%s\n", $fails ? 'FAIL' : 'PASS', $c['id'], implode(', ', $names), $fails ? '  ← ' . implode('; ', $fails) : '');
        continue;
    }
    // `shown`: slugs already on screen earlier in the conversation, recorded the way
    // AskController::rememberShownStudies does, then filtered the way it filters.
    $shown = [];
    foreach ($ctx->caseStudies() as $st) {
        if (in_array($st['slug'], $c['shown'] ?? [], true)) {
            foreach ([$st['client'], $st['title']] as $n) {
                if (trim((string) $n) !== '') $shown[] = mb_strtolower(trim((string) $n));
            }
        }
    }
    $lead = $ctx->withoutShown($lead, $shown);
    $slugs = array_column($ctx->withoutShown($ctx->caseStudies($c['answer'], false, $c['q'], $lead), $shown), 'slug');

    $fails = [];
    if (!empty($c['first']) && ($slugs[0] ?? null) !== $c['first']) {
        $fails[] = 'first was ' . ($slugs[0] ?? 'none') . ", not {$c['first']}";
    }
    if (!empty($c['min']) && count($slugs) < $c['min']) {
        $fails[] = count($slugs) . " card(s), min {$c['min']}";
    }
    if (isset($c['max']) && count($slugs) > $c['max']) {
        $fails[] = count($slugs) . " card(s), max {$c['max']}";
    }
    foreach ($c['has'] ?? [] as $s) {
        if (!in_array($s, $slugs, true)) $fails[] = "missing {$s}";
    }
    foreach ($c['hasNot'] ?? [] as $s) {
        if (in_array($s, $slugs, true)) $fails[] = "showed {$s}";
    }
    $failed += $fails ? 1 : 0;
    printf("%-5s %-32s [%s]%s\n", $fails ? 'FAIL' : 'PASS', $c['id'], implode(', ', $slugs), $fails ? '  ← ' . implode('; ', $fails) : '');
}

exit($failed ? 1 : 0);
