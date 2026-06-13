#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="${1:-}"

case "$HOST" in
  codex)
    SOURCE="$ROOT/hosts/codex/skills/ultraswarm"
    DEST_ROOT="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
    ;;
  claude)
    SOURCE="$ROOT/skills/ultraswarm"
    DEST_ROOT="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    ;;
  grok)
    SOURCE="$ROOT/hosts/grok/skills/ultraswarm"
    DEST_ROOT="${GROK_SKILLS_DIR:-$HOME/.grok/skills}"
    ;;
  *)
    echo "usage: $0 codex|claude|grok" >&2
    exit 2
    ;;
esac

DEST="$DEST_ROOT/ultraswarm"
mkdir -p "$DEST_ROOT"

if [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SOURCE")" ]; then
  echo "ultraswarm $HOST skill is already installed at $DEST"
  exit 0
fi
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "error: $DEST already exists and is not the expected symlink" >&2
  exit 1
fi

ln -s "$SOURCE" "$DEST"
echo "Installed ultraswarm $HOST skill at $DEST"
