<?php

use Craft;
use craft\helpers\App;

return [
    'checkDevServer' => true,
    'devServerInternal' => 'http://localhost:3000',
    'devServerPublic' => App::env('URL_SITE_PUBLIC') . ':3000',
    'useDevServer' => App::env('CRAFT_ENVIRONMENT') === 'dev',
    'manifestPath' => Craft::getAlias('@webroot') . '/dist/manifest.json',
    // Where rollup-plugin-critical writes to (see criticalBase in vite.config.js).
    // Without this the setting defaults to '' and includeCriticalCssTags() looks
    // for a bare relative filename, finds nothing, and silently returns ''.
    'criticalPath' => Craft::getAlias('@webroot') . '/dist/criticalcss',
    'serverPublic' => App::env('URL_SITE_PUBLIC') . '/dist/',
    'errorEntry' => 'build/js/app.js',
    'includeModulePreloadShim' => true,
    'includeReactRefreshShim' => false,
];
