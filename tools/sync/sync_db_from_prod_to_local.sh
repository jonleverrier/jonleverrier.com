#!/usr/bin/env bash
#
# PRODUCTION DATABASE -> LOCAL
#
# The safe direction, and the one worth running often: it brings down the real
# content, and with it the real Jonson analytics, which are the only honest data
# for judging whether the assistant is any good.
#
# The LOCAL database is backed up first, every time. That backup is the undo
# button for a pull that arrives mid-edit, and it costs a few seconds.
#
# Usage: tools/sync/sync_db_from_prod_to_local.sh

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_ddev
require_ssh

LOCAL_BACKUP="$BACKUP_DIR/local-before-pull-$STAMP.sql.gz"
PROD_DUMP="$BACKUP_DIR/prod-$STAMP.sql.gz"

step "1/3  Backing up the local database first"
ddev export-db --gzip=true --file="$LOCAL_BACKUP" >/dev/null
say "saved $(basename "$LOCAL_BACKUP") ($(du -h "$LOCAL_BACKUP" | cut -f1))"

step "2/4  Dumping production"
DB="$(remote_env CRAFT_DB_DATABASE)"
DU="$(remote_env CRAFT_DB_USER)"
DP="$(remote_env CRAFT_DB_PASSWORD)"
[ -n "$DB" ] && [ -n "$DU" ] && [ -n "$DP" ] || die "couldn't read DB credentials from $REMOTE_ENV"
say "database: $DB"

# --single-transaction so the dump is consistent without locking a live site.
# --no-tablespaces because on MySQL 8 the default needs the PROCESS privilege,
#   which a per-site Forge user does not have — without it mysqldump just fails.
# The password goes over the pipe in the remote command rather than being
#   written to a file on either machine.
sshx "MYSQL_PWD='$DP' mysqldump --single-transaction --quick --no-tablespaces \
        --default-character-set=utf8mb4 -h 127.0.0.1 -u '$DU' '$DB' | gzip -c" > "$PROD_DUMP"

[ -s "$PROD_DUMP" ] || die "the dump came back empty"
say "saved $(basename "$PROD_DUMP") ($(du -h "$PROD_DUMP" | cut -f1))"

step "3/4  Importing into ddev"
ddev import-db --file="$PROD_DUMP" >/dev/null
ddev exec "rm -rf craft/storage/runtime/cache/*" >/dev/null 2>&1 || true

TABLES=$(ddev mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()" 2>/dev/null | tr -d ' ')
ENTRIES=$(ddev mysql -N -e "SELECT COUNT(*) FROM entries" 2>/dev/null | tr -d ' ')
say "imported: $TABLES tables, $ENTRIES entries"

step "4/4  Re-pointing the VIP door URLs at this environment"
# mainSlug and altSlug store FULLY-QUALIFIED urls so they can be copied straight out
# of the CP — which means a dump carries production's hostname into wherever it lands.
# Left alone, every door in the local CP reads https://jonleverrier.com/vip/… and
# clicking one leaves the machine you are working on.
#
# Both fields are rebuilt from UrlHelper::siteUrl() on EVERY save (services/Vip.php),
# so a resave here regenerates them against this environment. Reusing the save handler
# rather than rewriting hostnames in SQL: there is one definition of what these fields
# contain, and it stays in PHP.
#
# The CLI is craft/craft — `php craft` exits 0 and does nothing at all.
ddev exec "php craft/craft resave/entries --section=vip" >/dev/null 2>&1 \
    && say "vip doors now point at this environment" \
    || say "WARNING: vip resave failed — doors still hold production URLs"

step "Done. Local now matches production."
say "rollback: ddev import-db --file=$LOCAL_BACKUP"
