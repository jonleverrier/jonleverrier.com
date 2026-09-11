<?php
define('CRAFT_BASE_PATH', __DIR__);
require __DIR__ . '/vendor/autoload.php';
Dotenv\Dotenv::createUnsafeImmutable(__DIR__)->safeLoad();
$app = require __DIR__ . '/vendor/craftcms/cms/bootstrap/console.php';

$sec = Craft::$app->entries->getSectionByHandle('pages');
$type = $sec->getEntryTypes()[0];
$e = new \craft\elements\Entry();
$e->sectionId = $sec->id;
$e->typeId = $type->id;
$e->title = 'ZZ Template Check';
$e->slug = 'zz-template-check';
$e->enabled = true;
$e->setFieldValues([
    'longTitle' => 'A longer heading for the check',
    'content' => '<p>First paragraph.</p><h2>A heading</h2><ul><li>One</li><li>Two</li></ul>',
]);
if (!Craft::$app->elements->saveElement($e)) {
    echo "SAVE FAILED: " . json_encode($e->getErrors()) . "\n";
    exit(1);
}
echo "created uri=" . $e->uri . " id=" . $e->id . "\n";
