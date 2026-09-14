#!/bin/bash
# The production deploy script. THIS FILE IS NOT RUN FROM THE REPO — it is the
# canonical copy of what lives in Laravel Forge (Site → Deploy Script). Edit here,
# commit, then paste the whole file into Forge. See README.md beside it.
set -euo pipefail

# PINNED, NOT INHERITED. Forge exports FORGE_SITE_PATH as the SITE directory
# (/home/forge/jonleverrier.com) — one level above the app, because this site keeps the
# code in current/ with shared/ as its sibling. Deriving APP from it lands on the parent,
# the craft/composer.json guard below fires, and the deploy aborts before doing anything.
SITE="$HOME/jonleverrier.com"
APP="$SITE/current"
SHARED="$SITE/shared"
BRANCH="${FORGE_SITE_BRANCH:-main}"
FPM="${FORGE_PHP_FPM:-php8.4-fpm}"

[ -f "$APP/craft/composer.json" ] || { echo "No app at $APP - check the layout"; exit 1; }
[ -f "$SHARED/.env" ]             || { echo "No .env at $SHARED - refusing to deploy"; exit 1; }

cd "$APP"
echo "==> pulling $BRANCH"
git pull origin "$BRANCH"

ln -nfs "$SHARED/.env" "$APP/craft/.env"
rm -rf "$APP/public/assets"
ln -nfs "$SHARED/assets" "$APP/public/assets"

echo "==> composer"
cd "$APP/craft"
chmod a+x craft
composer install --no-dev --no-interaction --optimize-autoloader --no-progress

echo "==> front end"
cd "$APP"
npm ci --no-audit --no-fund
URL=https://jonleverrier.com/ npm run build

echo "==> reloading $FPM"
sudo -n /usr/sbin/service "$FPM" reload

echo "Deploy complete"
