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
# NO SKIP_CRITICAL HERE. It was set during the server migration, when jonleverrier.com
# still resolved to the old box and the critical step would have measured the wrong site.
# DNS has moved, and leaving it set cost more than the whole JS budget: with no critical
# CSS the stylesheet is loaded async (media=print/onload), so the page painted UNSTYLED
# and re-laid out when it landed — the front door jumped 133px -> 789px at ~2.1s on a
# throttled phone. Measured on prod 2026-09-15: CLS 0.446 (0.409 of it that one reflow)
# and LCP 4.1s, against 22kB of inlined critical CSS locally versus 2.2kB on prod.
#
# If this ever needs to come back (Chrome crashing in the build, a page erroring under
# the crawler), set it for ONE deploy to get a release out, then remove it and deploy
# again. Do not leave it.
URL=https://jonleverrier.com/ npm run build

echo "==> reloading $FPM"
sudo -n /usr/sbin/service "$FPM" reload

# The queue daemon holds PHP in memory, so it keeps running the code it started with —
# a deploy that changes a job would otherwise not take effect until something happened
# to restart it. `restart all` is safe here because the queue listener is the only
# supervisor program on this box; name it explicitly if that ever stops being true.
echo "==> restarting the queue daemon"
sudo -n /usr/bin/supervisorctl restart all || echo "(no daemon to restart)"

echo "Deploy complete"
