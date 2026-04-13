#!/usr/bin/env bash
# Plugin install/update/uninstall helpers for local dev.
#
# Usage:
#   bun run plugin:install          # local marketplace from this repo + install
#   bun run plugin:update           # rebuild core + refresh marketplace + update
#   bun run plugin:uninstall        # uninstall plugin + remove marketplace
#   bun run plugin:install-remote   # install from github (desplega-ai/code-mode)
#
# "Local binding" = marketplace source points at this repo's working tree.
# Rebuild packages/core/dist so the plugin's start.mjs resolver picks up
# your local changes (unless you also export CODE_MODE_DEV_PATH, which
# bypasses the marketplace entirely — see CONTRIBUTING.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE="code-mode"
PLUGIN="code-mode"
REMOTE="desplega-ai/code-mode"

log() { printf '[plugin] %s\n' "$*"; }

build_core() {
  log "building packages/core..."
  bun run --cwd "$REPO_ROOT/packages/core" build
}

require_claude() {
  command -v claude >/dev/null 2>&1 || {
    echo "error: 'claude' CLI not found in PATH" >&2
    exit 1
  }
}

cleanup_existing() {
  # Best-effort: remove any prior install so swapping between local<->remote is clean.
  claude plugin uninstall "$PLUGIN" >/dev/null 2>&1 || true
  claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
}

cmd_install() {
  require_claude
  build_core
  cleanup_existing
  log "adding local marketplace from $REPO_ROOT"
  claude plugin marketplace add "$REPO_ROOT" --scope user
  log "installing $PLUGIN@$MARKETPLACE (local)"
  claude plugin install "$PLUGIN@$MARKETPLACE" --scope user
  log "done. Restart Claude Code (or /plugin reload) to activate."
}

cmd_install_remote() {
  require_claude
  cleanup_existing
  log "adding remote marketplace $REMOTE"
  claude plugin marketplace add "$REMOTE" --scope user
  log "installing $PLUGIN@$MARKETPLACE (remote)"
  claude plugin install "$PLUGIN@$MARKETPLACE" --scope user
  log "done. Restart Claude Code (or /plugin reload) to activate."
}

cmd_update() {
  require_claude
  build_core
  log "refreshing marketplace $MARKETPLACE"
  claude plugin marketplace update "$MARKETPLACE"
  log "updating $PLUGIN@$MARKETPLACE"
  claude plugin update "$PLUGIN@$MARKETPLACE"
  log "done. Restart Claude Code (or /plugin reload) to pick up changes."
}

cmd_uninstall() {
  require_claude
  log "uninstalling $PLUGIN"
  claude plugin uninstall "$PLUGIN" || log "(plugin was not installed)"
  log "removing marketplace $MARKETPLACE"
  claude plugin marketplace remove "$MARKETPLACE" || log "(marketplace was not registered)"
  log "done."
}

case "${1:-}" in
  install)        cmd_install ;;
  install-remote) cmd_install_remote ;;
  update)         cmd_update ;;
  uninstall)      cmd_uninstall ;;
  *)
    echo "Usage: $0 {install|install-remote|update|uninstall}" >&2
    exit 1
    ;;
esac
