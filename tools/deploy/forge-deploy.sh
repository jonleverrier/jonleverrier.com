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
# TEMPORARY — MIGRATION ONLY. Remove SKIP_CRITICAL=1 once DNS points at this server.
# The critical-CSS step renders URL in headless Chrome to find what is above the fold,
# and jonleverrier.com still resolves to the OLD box, so it would either measure the old
# site or fail outright. Deploy once with it set, cut DNS over, then delete this line's
# prefix and deploy again to generate real critical CSS.
SKIP_CRITICAL=1 URL=https://jonleverrier.com/ npm run build

echo "==> reloading $FPM"
sudo -n /usr/sbin/service "$FPM" reload

# The queue daemon holds PHP in memory, so it keeps running the code it started with —
# a deploy that changes a job would otherwise not take effect until something happened
# to restart it. `restart all` is safe here because the queue listener is the only
# supervisor program on this box; name it explicitly if that ever stops being true.
echo "==> restarting the queue daemon"
sudo -n /usr/bin/supervisorctl restart all || echo "(no daemon to restart)"

echo "Deploy complete"
