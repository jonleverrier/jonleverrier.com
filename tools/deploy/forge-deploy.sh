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

# The audit tool drives a browser, and Playwright brings its OWN rather than using the
# one the critical-CSS step has. They are different caches and different binaries:
# ~/.cache/puppeteer holds Chrome for Testing, ~/.cache/ms-playwright holds Playwright's
# build, and neither can stand in for the other.
#
# OUTSIDE THE RELEASE DIRECTORY, which is the point — the cache lives in the home
# directory, so it survives every deploy and this line is a no-op (a second or two)
# except when the Playwright version actually moves. About 115MB when it does download.
#
# NOT FATAL. A release must not fail over a browser for a lead magnet: without it the
# site serves fine and the audit queue job is the only thing that cannot run, which it
# reports as a failed audit rather than as a broken deploy.
npx playwright install chromium || echo "WARNING: playwright chromium not installed — audits will fail until it is"
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

# WARM, so no visitor pays for the deploy. composer's post-install hook ran
# clear-caches/all and FPM has just reloaded: every page's template cache, compiled Twig
# and opcache are cold, and the first person to each page waited for all of it (a case
# study measured 3.2s once, against ~0.3s warm). Request every page in the sitemap, plus
# the files agents fetch, one at a time so the site stays responsive while it runs.
#
# Straight to this box, not through Cloudflare: /etc/hosts maps jonleverrier.com to
# 127.0.0.1 (see README), so these never leave the server. A render also queues any image
# transforms the page is missing; the queue daemon restarted above builds them.
#
# NEVER FATAL, AND BOUNDED. A page that fails to warm is a page the first visitor warms
# instead — not a reason to fail a release that is already live. 15s a request and 120s
# in all, so a site that hangs on every page holds the deploy for two minutes, not 60 x 60s.
echo "==> warming caches"
WARM_BUDGET=120
warm() {
    # curl prints 000 itself when it can't connect or times out; `|| true` only stops a
    # non-zero exit from ending the script, without printing a second code.
    curl -s -o /dev/null --max-time 15 -A "jonleverrier-deploy-warm" -w '%{http_code}' "$1" || true
}
set +e
START=$SECONDS; OK=0; SKIPPED=0; FAILED=""
URLS=$(curl -s --max-time 15 -A "jonleverrier-deploy-warm" https://jonleverrier.com/sitemap.xml \
    | grep -o '<loc>[^<]*</loc>' | sed -e 's/<loc>//' -e 's/<\/loc>//')
for u in $URLS https://jonleverrier.com/llms.txt https://jonleverrier.com/llms-full.txt https://jonleverrier.com/notes.rss; do
    if [ $((SECONDS - START)) -ge "$WARM_BUDGET" ]; then SKIPPED=$((SKIPPED + 1)); continue; fi
    code=$(warm "$u")
    if [ "$code" = "200" ]; then OK=$((OK + 1)); else FAILED="$FAILED $code:$u"; fi
done
echo "warmed $OK pages in $((SECONDS - START))s"
[ -n "$FAILED" ] && echo "  not 200:$FAILED"
[ "$SKIPPED" -gt 0 ] && echo "  skipped $SKIPPED: over the ${WARM_BUDGET}s budget"
set -e

echo "Deploy complete"
