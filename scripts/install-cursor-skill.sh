#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$ROOT/hosts/agent/skills/ultraswarm"
DEST_ROOT="${CURSOR_SKILLS_DIR:-$HOME/.cursor/skills}"
DEST="$DEST_ROOT/ultraswarm"

if [ ! -f "$SOURCE/SKILL.md" ]; then
  echo "error: Cursor agent skill not found at $SOURCE/SKILL.md" >&2
  echo "hint: run node scripts/generate-host-skills.mjs first" >&2
  exit 1
fi

mkdir -p "$DEST_ROOT"

if [ -L "$DEST" ]; then
  current="$(readlink -f "$DEST")"
  expected="$(readlink -f "$SOURCE")"
  if [ "$current" = "$expected" ]; then
    echo "ultraswarm Cursor skill is already installed at $DEST"
    exit 0
  fi
  echo "error: $DEST points to $current; remove it before installing" >&2
  exit 1
fi

if [ -e "$DEST" ]; then
  echo "error: $DEST already exists; remove it before installing" >&2
  exit 1
fi

ln -s "$SOURCE" "$DEST"
echo "Installed ultraswarm Cursor skill at $DEST"
echo "Restart Cursor, then invoke the ultraswarm skill to orchestrate work."
