#!/usr/bin/env bash
# release.sh — publish @desplega/code-mode to npm, warm npx cache, tag git.
#
# Assumes the version bump has already been committed and version fields
# are consistent across the three manifests. Run it from the repo root
# (or let it re-resolve — it uses absolute paths).
#
# Usage:
#   bun run release              # real release
#   bun run release dry          # dry-run: shows what would happen
#
# What it does (aborts on any failure):
#   1. Verify clean git, on main, in sync with origin
#   2. Verify version lockstep across three manifests
#   3. Run prepublishOnly (typecheck + test + build)
#   4. npm publish (or `npm publish --dry-run` in dry mode)
#   5. Warm npx cache: npx -y @desplega/code-mode@latest --version
#   6. Tag v<version> + push tag
#
# Prerequisite: `npm whoami` must work (logged in to npm).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="$REPO_ROOT/packages/core"
PLUGIN_MANIFEST="$REPO_ROOT/plugins/code-mode/.claude-plugin/plugin.json"
MARKETPLACE_MANIFEST="$REPO_ROOT/.claude-plugin/marketplace.json"
PACKAGE_MANIFEST="$CORE_DIR/package.json"

DRY_RUN=0
if [[ "${1:-}" == "dry" || "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

log() { printf '[release] %s\n' "$*"; }
die() { printf '[release] error: %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"
}

# ─── 1. Git sanity ───────────────────────────────────────────────────

require git
require jq
require node
require npm
require bun

cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree is dirty — commit or stash first"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  die "must be on 'main' (currently on '$BRANCH')"
fi

log "fetching origin to check sync..."
git fetch origin main --quiet
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  die "local main ($LOCAL_SHA) differs from origin/main ($REMOTE_SHA) — push or pull first"
fi

# ─── 2. Version lockstep ─────────────────────────────────────────────

PLUGIN_VERSION=$(jq -r '.version' "$PLUGIN_MANIFEST")
MARKETPLACE_META_VERSION=$(jq -r '.metadata.version' "$MARKETPLACE_MANIFEST")
MARKETPLACE_PLUGIN_VERSION=$(jq -r '.plugins[0].version' "$MARKETPLACE_MANIFEST")
PACKAGE_VERSION=$(jq -r '.version' "$PACKAGE_MANIFEST")

log "manifest versions:"
printf '  plugin.json            %s\n' "$PLUGIN_VERSION"
printf '  marketplace.metadata   %s\n' "$MARKETPLACE_META_VERSION"
printf '  marketplace.plugins[0] %s\n' "$MARKETPLACE_PLUGIN_VERSION"
printf '  packages/core          %s\n' "$PACKAGE_VERSION"

if [[ "$PLUGIN_VERSION" != "$MARKETPLACE_META_VERSION" \
   || "$PLUGIN_VERSION" != "$MARKETPLACE_PLUGIN_VERSION" \
   || "$PLUGIN_VERSION" != "$PACKAGE_VERSION" ]]; then
  die "version mismatch — all four must match before publishing"
fi

VERSION="$PACKAGE_VERSION"
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists — bump version and retry"
fi

# Check npm doesn't already have this version (avoid publish-conflict surprise)
if npm view "@desplega/code-mode@$VERSION" version >/dev/null 2>&1; then
  die "@desplega/code-mode@$VERSION is already on npm — bump version"
fi

# ─── 3. prepublishOnly ───────────────────────────────────────────────
# packages/core's `prepublishOnly` runs typecheck + test + build. `npm
# publish` triggers it automatically, but run it explicitly first so a
# failure aborts before we touch the registry.

log "running typecheck + test + build..."
bun run --cwd "$CORE_DIR" typecheck
bun run --cwd "$CORE_DIR" test
bun run --cwd "$CORE_DIR" build

# ─── 4. npm publish ──────────────────────────────────────────────────

require_login() {
  if ! npm whoami >/dev/null 2>&1; then
    die "not logged in to npm — run 'npm login' first"
  fi
}

if (( DRY_RUN )); then
  log "[dry] would publish @desplega/code-mode@$VERSION"
  (cd "$CORE_DIR" && npm publish --dry-run)
else
  require_login
  log "publishing @desplega/code-mode@$VERSION..."
  (cd "$CORE_DIR" && npm publish)
fi

# ─── 5. Warm npx cache ───────────────────────────────────────────────

if (( DRY_RUN )); then
  log "[dry] would warm npx cache"
else
  log "warming npx cache (npx -y @desplega/code-mode@latest --version)..."
  WARM_VERSION="$(npx -y "@desplega/code-mode@latest" --version 2>&1 | tail -1)"
  if [[ "$WARM_VERSION" != "$VERSION" ]]; then
    log "warning: npx returned '$WARM_VERSION', expected '$VERSION'"
    log "  (registry propagation delay, usually <60s — safe to re-run)"
  else
    log "npx cache warmed to $VERSION"
  fi
fi

# ─── 6. Tag + push ───────────────────────────────────────────────────

if (( DRY_RUN )); then
  log "[dry] would tag $TAG and push"
else
  log "tagging $TAG and pushing..."
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "$TAG"
fi

log "done. Released $VERSION."
if (( DRY_RUN == 0 )); then
  log "next: bun run plugin:update + /plugin reload in Claude Code to pick up the new MCP server."
fi
