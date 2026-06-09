#!/usr/bin/env bash
set -euo pipefail

# ultraswarm release validator.
# Runs a series of release-blocking checks against the repo tree.
# Exits non-zero on the first failed check, with a clear message per check.
# Run from the repo root: bash scripts/validate.sh

# Resolve repo root from this script's location so it can be run from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGIN_JSON="$ROOT/.claude-plugin/plugin.json"
MARKET_JSON="$ROOT/.claude-plugin/marketplace.json"
SKILL_MD="$ROOT/skills/ultraswarm/SKILL.md"
CONFIG_JSON="$ROOT/ultraswarm.config.example.json"

fails=0
pass() { printf '  \xe2\x9c\x93 %s\n' "$1"; }
fail() { printf '  \xe2\x9c\x97 %s\n' "$1"; fails=$((fails + 1)); }

# --- Check 1: Manifests parse -------------------------------------------------
echo "[1] Manifests parse"
if jq empty "$PLUGIN_JSON" 2>/dev/null; then
  pass "plugin.json is valid JSON"
else
  fail "plugin.json is not valid JSON"
fi
if jq empty "$MARKET_JSON" 2>/dev/null; then
  pass "marketplace.json is valid JSON"
else
  fail "marketplace.json is not valid JSON"
fi

# --- Check 2: No manifest conflict --------------------------------------------
# The marketplace plugin entry must NOT declare component keys (skills/commands/
# agents) while plugin.json exists — that combination caused a v0.3 load error.
echo "[2] No manifest conflict (marketplace plugin entry vs plugin.json)"
if [ -f "$PLUGIN_JSON" ]; then
  if jq -e '.plugins[0] | has("skills") or has("commands") or has("agents")' \
      "$MARKET_JSON" >/dev/null 2>&1; then
    fail "marketplace.json plugins[0] declares skills/commands/agents while plugin.json exists"
  else
    pass "marketplace.json plugins[0] declares no component keys"
  fi
else
  pass "plugin.json absent — component-key conflict not possible"
fi

# --- Check 3: Versions agree --------------------------------------------------
echo "[3] Versions agree"
v_plugin="$(jq -r '.version' "$PLUGIN_JSON")"
v_meta="$(jq -r '.metadata.version' "$MARKET_JSON")"
v_entry="$(jq -r '.plugins[0].version' "$MARKET_JSON")"
echo "      plugin.json .version            = $v_plugin"
echo "      marketplace.json .metadata.version   = $v_meta"
echo "      marketplace.json .plugins[0].version = $v_entry"
if [ "$v_plugin" = "$v_meta" ] && [ "$v_meta" = "$v_entry" ]; then
  pass "all three versions match ($v_plugin)"
else
  fail "version mismatch across manifests"
fi

# --- Check 4: Embedded Workflow JS parses -------------------------------------
echo "[4] Embedded Workflow JS parses"
TMP_JS="$(mktemp --suffix=.js)"
trap 'rm -f "$TMP_JS"' EXIT

# Extract the fenced block between a full-line ```js and the next full-line ```.
# Anchor on full lines so ```json does not match.
awk '
  /^```js$/ { grab = 1; next }
  grab && /^```$/ { exit }
  grab { print }
' "$SKILL_MD" > "$TMP_JS"

if [ ! -s "$TMP_JS" ]; then
  fail "could not extract a non-empty \`\`\`js block from SKILL.md"
else
  # Strip the leading `export const meta = { ... }` object literal (terminated by
  # the first line that is exactly `}` at column 0), then validate the remaining
  # script body parses as an async function body.
  if node -e "const src=require('fs').readFileSync('$TMP_JS','utf8').replace(/^export const meta[\s\S]*?\n}\n/,''); new Function('args','agent','parallel','pipeline','log','budget','return (async()=>{'+src+'})()');" 2>/tmp/.us_node_err; then
    pass "Workflow JS body parses as an async function body"
  else
    fail "Workflow JS body failed to parse: $(cat /tmp/.us_node_err 2>/dev/null | head -1)"
  fi
  rm -f /tmp/.us_node_err
fi

# --- Check 5: No resume-breaking tokens in the JS block -----------------------
echo "[5] No resume-breaking tokens in Workflow JS"
if [ -s "$TMP_JS" ]; then
  bad=""
  for tok in 'Date.now(' 'Math.random(' 'new Date('; do
    if grep -qF "$tok" "$TMP_JS"; then
      bad="$bad $tok"
    fi
  done
  if [ -n "$bad" ]; then
    fail "Workflow JS contains non-deterministic token(s):$bad"
  else
    pass "no Date.now( / Math.random( / new Date( in Workflow JS"
  fi
else
  fail "skipped — no JS block extracted"
fi

# --- Check 6: Example config valid --------------------------------------------
echo "[6] Example config valid"
if jq empty "$CONFIG_JSON" 2>/dev/null; then
  pass "ultraswarm.config.example.json is valid JSON"
else
  fail "ultraswarm.config.example.json is not valid JSON"
fi

# --- Check 7: Skill frontmatter present ---------------------------------------
echo "[7] Skill frontmatter present"
first_line="$(head -n 1 "$SKILL_MD")"
if [ "$first_line" != "---" ]; then
  fail "SKILL.md first line is not '---' (got '$first_line')"
else
  # Inspect the frontmatter block (between the first '---' and the next '---').
  fm="$(awk 'NR==1{next} /^---$/{exit} {print}' "$SKILL_MD")"
  if printf '%s\n' "$fm" | grep -q '^name:' && \
     printf '%s\n' "$fm" | grep -q '^description:'; then
    pass "frontmatter present with name: and description:"
  else
    fail "frontmatter missing name: or description:"
  fi
fi

# --- Summary ------------------------------------------------------------------
echo
if [ "$fails" -eq 0 ]; then
  printf '\xe2\x9c\x93 All checks passed.\n'
  exit 0
else
  printf '\xe2\x9c\x97 %d check(s) failed.\n' "$fails"
  exit 1
fi
