#!/usr/bin/env bash
set -euo pipefail

# Install codex-to-im skill for Codex.
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

SKILL_NAME="codex-to-im"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LINK_MODE="${1:-}"

echo "Installing $SKILL_NAME skill for Codex..."

# Check source
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

# Create skills directory
mkdir -p "$CODEX_SKILLS_DIR"

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

if [ ! -f "$SOURCE_DIR/vendor/claude-to-im/package.json" ]; then
  echo "Error: vendored bridge package missing: $SOURCE_DIR/vendor/claude-to-im/package.json"
  echo "This repo should be self-contained. Re-clone Codex-to-IM-skill and try again."
  exit 1
fi

if [ "$LINK_MODE" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR → $SOURCE_DIR"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
  echo "Copied to: $TARGET_DIR"
fi

# Ensure dependencies (need devDependencies for build step)
echo "Installing dependencies..."
(cd "$TARGET_DIR" && npm install)

echo "Building daemon bundle..."
(cd "$TARGET_DIR" && npm run build)

if [ "$LINK_MODE" = "--link" ]; then
  echo "Keeping dev dependencies because --link mode is for live development."
else
  echo "Keeping build dependencies in place to avoid breaking the vendored bridge package during post-install pruning."
fi

echo ""
echo "Done! Start a new Codex session and use:"
echo "  codex-to-im setup    — configure IM platform credentials"
echo "  codex-to-im start    — start the bridge daemon"
echo "  codex-to-im doctor   — diagnose issues"
