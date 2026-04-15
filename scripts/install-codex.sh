#!/usr/bin/env bash
set -euo pipefail

# Install codex-to-im skill for Codex.
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

SKILL_NAME="codex-to-im"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_NAME="Claude-to-IM"
UPSTREAM_REPO_URL="https://github.com/op7418/Claude-to-IM.git"
UPSTREAM_DIR="$CODEX_SKILLS_DIR/$UPSTREAM_NAME"
SOURCE_PARENT_DIR="$(cd "$SOURCE_DIR/.." && pwd)"
DEV_UPSTREAM_ALIAS="$SOURCE_PARENT_DIR/$UPSTREAM_NAME"

echo "Installing $SKILL_NAME skill for Codex..."

# Check source
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

# Create skills directory
mkdir -p "$CODEX_SKILLS_DIR"

ensure_upstream_repo() {
  if [ -d "$UPSTREAM_DIR/.git" ]; then
    echo "Found upstream bridge repo at: $UPSTREAM_DIR"
  elif [ -e "$UPSTREAM_DIR" ]; then
    echo "Error: expected upstream repo path exists but is not a git checkout: $UPSTREAM_DIR"
    exit 1
  else
    echo "Cloning upstream bridge repo..."
    git clone "$UPSTREAM_REPO_URL" "$UPSTREAM_DIR"
  fi

  if [ ! -d "$UPSTREAM_DIR/node_modules" ] || [ ! -f "$UPSTREAM_DIR/dist/lib/bridge/context.js" ]; then
    echo "Installing upstream bridge dependencies..."
    (cd "$UPSTREAM_DIR" && npm install)
  fi
}

ensure_link_mode_upstream_alias() {
  if [ -e "$DEV_UPSTREAM_ALIAS" ]; then
    if [ -L "$DEV_UPSTREAM_ALIAS" ] && [ "$(readlink -f "$DEV_UPSTREAM_ALIAS")" = "$UPSTREAM_DIR" ]; then
      echo "Found development upstream alias: $DEV_UPSTREAM_ALIAS -> $UPSTREAM_DIR"
      return 0
    fi

    if [ -d "$DEV_UPSTREAM_ALIAS/.git" ] || [ -f "$DEV_UPSTREAM_ALIAS/package.json" ]; then
      echo "Found development upstream repo at: $DEV_UPSTREAM_ALIAS"
      return 0
    fi

    echo "Error: expected development upstream path exists but is incompatible: $DEV_UPSTREAM_ALIAS"
    echo "Remove it or replace it with the bridge library repo, then rerun the installer."
    exit 1
  fi

  ln -s "$UPSTREAM_DIR" "$DEV_UPSTREAM_ALIAS"
  echo "Linked development upstream alias: $DEV_UPSTREAM_ALIAS -> $UPSTREAM_DIR"
}

# Check if already installed
if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    echo "Already installed as symlink → $EXISTING"
    echo "To reinstall, remove it first: rm $TARGET_DIR"
    exit 0
  else
    echo "Already installed at $TARGET_DIR"
    echo "To reinstall, remove it first: rm -rf $TARGET_DIR"
    exit 0
  fi
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR → $SOURCE_DIR"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
  echo "Copied to: $TARGET_DIR"
fi

ensure_upstream_repo

if [ "${1:-}" = "--link" ]; then
  ensure_link_mode_upstream_alias
fi

# Ensure dependencies (need devDependencies for build step)
if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

# Ensure build
if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

# Prune devDependencies after build
echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done! Start a new Codex session and use:"
echo "  codex-to-im setup    — configure IM platform credentials"
echo "  codex-to-im start    — start the bridge daemon"
echo "  codex-to-im doctor   — diagnose issues"
