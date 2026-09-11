#!/usr/bin/env bash
#
# LOCAL DATABASE -> PRODUCTION   ** DESTRUCTIVE **
#
# This REPLACES the live database. Everything only production has is gone:
#
#   - every Jonson conversation, question and token count since the last push
#     (jonson_visits / jonson_turns / jonson_presence)
#   - any entry written or edited in the live control panel
#   - every logged-in session
#
# It exists for the one case that genuinely needs it — seeding a new server, or
# pushing a structural change too large to express through project config — and
# should be rare. Routine schema and field changes travel in project config,
# which `craft up` applies on deploy without touching content.
#
# Production is dumped to .backups/ before anything is written, and the restore
# command is printed at the end.
#
# Usage: tools/sync/sync_db_from_local_to_prod.sh

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_ddev
require_ssh

DB="$(remote_env CRAFT_DB_DATABASE)"
DU="$(remote_env CRAFT_DB_USER)"
DP="$(remote_env CRAFT_DB_PASSWORD)"
[ -n "$DB" ] && [ -n "$DU" ] && [ -n "$DP" ] || die "couldn't read DB credentials from $REMOTE_ENV"

# The security key encrypts stored values. Push a database whose contents were
# encrypted under a different key and production keeps running while quietly
# failing to read anything sensitive — so it is checked BEFORE the confirmation,
# by comparing hashes rather than moving either key around.
LOCAL_KEY_HASH="$(printf '%s' "$(envval CRAFT_SECURITY_KEY)" | shasum -a 256 | cut -c1-16)"
# tr -d '\n' before hashing, on BOTH sides. sed and head each emit a trailing
# newline and sha256sum hashes it, so without this the remote digest covers
# "key\n" while the local one covers "key" — they never match, and the guard
# blocks every push including the correct ones.
PROD_KEY_HASH="$(sshx "sed -n 's/^CRAFT_SECURITY_KEY=//p' '$REMOTE_ENV' | head -1 | tr -d '\"' | tr -d '\r' | tr -d '\n' | sha256sum | cut -c1-16")"
[ "$LOCAL_KEY_HASH" = "$PROD_KEY_HASH" ] \
    || die "CRAFT_SECURITY_KEY differs between local and production.
         Pushing would leave every encrypted value unreadable.
         local $LOCAL_KEY_HASH / prod $PROD_KEY_HASH"

LIVE_ROWS="$(sshx "MYSQL_PWD='$DP' mysql -N -h 127.0.0.1 -u '$DU' '$DB' -e \
    'SELECT COALESCE(SUM(n),0) FROM (SELECT COUNT(*) n FROM jonson_turns UNION ALL SELECT COUNT(*) FROM jonson_visits) x'" 2>/dev/null || echo '?')"

confirm "OVERWRITE-PRODUCTION" \
"About to REPLACE the live database on $SSH_HOST ($DB).
  Production currently holds $LIVE_ROWS Jonson analytics rows — they will be destroyed.
  A backup is taken first."

PROD_BACKUP="$BACKUP_DIR/prod-before-push-$STAMP.sql.gz"
LOCAL_DUMP="$BACKUP_DIR/local-$STAMP.sql.gz"

step "1/4  Backing up production"
sshx "MYSQL_PWD='$DP' mysqldump --single-transaction --quick --no-tablespaces \
        --default-character-set=utf8mb4 -h 127.0.0.1 -u '$DU' '$DB' | gzip -c" > "$PROD_BACKUP"
[ -s "$PROD_BACKUP" ] || die "production backup came back empty — stopping before any write"
say "saved $(basename "$PROD_BACKUP") ($(du -h "$PROD_BACKUP" | cut -f1))"

step "2/4  Dumping local"
ddev export-db --gzip=true --file="$LOCAL_DUMP" >/dev/null
say "saved $(basename "$LOCAL_DUMP") ($(du -h "$LOCAL_DUMP" | cut -f1))"

step "3/4  Importing into production"
gunzip -c "$LOCAL_DUMP" | sshx_stdin "MYSQL_PWD='$DP' mysql -h 127.0.0.1 -u '$DU' '$DB'"
say "imported"

step "4/4  Migrations, project config, caches"
# compiled_classes first: a changed controller route 404s until it is cleared.
sshx "rm -rf '$SSH_PATH/shared/storage/runtime/compiled_classes' \
      && cd '$SSH_PATH/current/craft' && ./craft up --interactive=0" 2>&1 | tail -4 | sed 's/^/  /'

step "Done."
say "rollback: gunzip -c $PROD_BACKUP | ssh $REMOTE \"MYSQL_PWD=... mysql -h 127.0.0.1 -u $DU $DB\""
