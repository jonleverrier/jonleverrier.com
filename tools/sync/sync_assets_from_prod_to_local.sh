#!/usr/bin/env bash
#
# PRODUCTION ASSETS -> LOCAL
#
# Brings down public/assets — the uploaded originals AND the generated
# transforms (the _1200x630_crop_… directories). The transforms come too on
# purpose: they are named from the transform index in the database, so a pull
# that included the database and not these would leave every image regenerating
# on first view.
#
# ADDITIVE by default: nothing local is deleted. Pass --delete to make local an
# exact mirror, which is what you want after assets have been removed in the
# live control panel and the local copy still has them.
#
# Usage: tools/sync/sync_assets_from_prod_to_local.sh [--delete]

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_ssh

FLAGS=("${RSYNC_FLAGS[@]}")
MODE="additive (nothing local deleted)"
if [ "${1:-}" = "--delete" ]; then
    FLAGS+=(--delete)
    MODE="mirror (local files missing from production WILL be deleted)"
    confirm "DELETE-LOCAL" "Mirroring production into $ROOT/public/assets."
fi

LOCAL_ASSETS="$ROOT/public/assets"
mkdir -p "$LOCAL_ASSETS"

step "Pulling assets from production"
say "mode: $MODE"
say "from: $REMOTE:$REMOTE_ASSETS/"
say "to:   $LOCAL_ASSETS/"

REMOTE_SIZE="$(sshx "du -sh '$REMOTE_ASSETS' 2>/dev/null | cut -f1")"
say "remote size: ${REMOTE_SIZE:-unknown}"

rsync "${FLAGS[@]}" -e "ssh ${SSH_OPTS[*]}" \
    "$REMOTE:$REMOTE_ASSETS/" "$LOCAL_ASSETS/"

step "Done."
say "local size:  $(du -sh "$LOCAL_ASSETS" | cut -f1)"
say "local files: $(find "$LOCAL_ASSETS" -type f | wc -l | tr -d ' ')"
