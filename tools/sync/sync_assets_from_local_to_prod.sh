#!/usr/bin/env bash
#
# LOCAL ASSETS -> PRODUCTION
#
# Pushes public/assets into the server's shared/assets, which is symlinked into
# each release — that symlink is what lets generated transforms survive a deploy,
# and it is why assets are not in git.
#
# Mainly for seeding a new server. In normal life assets are uploaded through
# the live control panel and travel the other way.
#
# ADDITIVE by default: nothing on production is deleted. --delete makes
# production an exact mirror of this machine, which will remove any image
# uploaded live since the last pull — hence the typed confirmation.
#
# Usage: tools/sync/sync_assets_from_local_to_prod.sh [--delete]

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_ssh

LOCAL_ASSETS="$ROOT/public/assets"
[ -d "$LOCAL_ASSETS" ] || die "no public/assets directory here"

FLAGS=("${RSYNC_FLAGS[@]}")
MODE="additive (nothing on production deleted)"
if [ "${1:-}" = "--delete" ]; then
    FLAGS+=(--delete)
    MODE="mirror (production files missing locally WILL be deleted)"
    confirm "DELETE-PRODUCTION-ASSETS" \
"Mirroring this machine into $REMOTE:$REMOTE_ASSETS.
  Anything uploaded through the live control panel since your last pull will be removed."
fi

step "Pushing assets to production"
say "mode: $MODE"
say "from: $LOCAL_ASSETS/"
say "to:   $REMOTE:$REMOTE_ASSETS/"
say "local size: $(du -sh "$LOCAL_ASSETS" | cut -f1)"

sshx "mkdir -p '$REMOTE_ASSETS'"
rsync "${FLAGS[@]}" -e "ssh ${SSH_OPTS[*]}" \
    "$LOCAL_ASSETS/" "$REMOTE:$REMOTE_ASSETS/"

step "Done."
sshx "du -sh '$REMOTE_ASSETS' | cut -f1" | sed 's/^/  remote size: /'
sshx "find '$REMOTE_ASSETS' -type f | wc -l" | tr -d ' ' | sed 's/^/  remote files: /'
