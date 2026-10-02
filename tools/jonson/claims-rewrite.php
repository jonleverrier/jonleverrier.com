<?php
/**
 * The claim check's rewrite path, end to end, on a planted bad answer ("in-house at …
 * Lloyds", "worked with Apple"): one real API call, a few cents. Prints the rewrite,
 * how long it took, whether it's clean, and the last-resort cut.
 *
 *   ddev exec "php tools/jonson/claims-rewrite.php"
 */
use craft\helpers\App;
use GuzzleHttp\Client;
use modules\jonson\Jonson;
use modules\jonson\controllers\AskController;
require dirname(__DIR__, 2) . '/craft/bootstrap.php';
$app = require CRAFT_VENDOR_PATH . '/craftcms/cms/bootstrap/console.php';
$j = Jonson::getInstance();
$ask = new AskController('ask', $j);
$system = (new ReflectionMethod($ask, 'claimContext'))->invoke($ask);
$q = 'Who have you worked with?';
$bad = "Quite a range over 20-odd years — from in-house at HSBC International and Lloyds Bank International, to branding and product design for Vaiie, and I've worked with Apple too.\n\nMost recently it's been regtech and conference platforms.[[clients]]";
$t = microtime(true);
$gen = (new ReflectionMethod($ask, 'checkClaims'))->invoke($ask, $bad, new Client(['timeout' => 10, 'read_timeout' => 60, 'http_errors' => false]), App::env('KEY_ANTHROPIC_API'), App::env('KEY_ANTHROPIC_MODEL') ?: 'claude-opus-4-8', $system, '', [['role' => 'user', 'content' => $q]], $q);
foreach ($gen as $_) {}
$out = $gen->getReturn();
printf("%.1fs\n%s\n\nstill: %s\n", microtime(true) - $t, $out, json_encode($j->claimCheck->problems($out, $system, $j->findContext->employers(), $j->findContext->workNames())));
echo "\ncut fallback: ", $j->claimCheck->withoutSentences($bad, ['Lloyds Bank International', 'Apple']), "\n";
