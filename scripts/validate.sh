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
ROUTER_MJS="$ROOT/scripts/router.mjs"
ROUTER_TEST="$ROOT/scripts/router.test.mjs"
ADV_CFG="$ROOT/ultraswarm.config.advanced.json"
WORKFLOW_TEST="$ROOT/scripts/workflow-harness.test.mjs"

JSON_MODE=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
  esac
done

CURRENT_CHECK=0
CURRENT_CHECK_NAME=""
JSON_TMP=""
if [ "$JSON_MODE" -eq 1 ]; then
  JSON_TMP="$(mktemp)"
fi

fails=0
begin_check() {
  CURRENT_CHECK="$1"
  CURRENT_CHECK_NAME="$2"
  if [ "$JSON_MODE" -eq 0 ]; then
    echo "[$CURRENT_CHECK] $CURRENT_CHECK_NAME"
  fi
}
record_json() {
  CHECK="$CURRENT_CHECK" NAME="$CURRENT_CHECK_NAME" node -e '
    console.log(JSON.stringify({
      check: Number(process.env.CHECK),
      name: process.env.NAME,
      pass: process.argv[1] === "true",
      detail: process.argv[2],
    }));
  ' "$1" "$2" >>"$JSON_TMP"
}
pass() {
  if [ "$JSON_MODE" -eq 1 ]; then
    record_json true "$1"
  else
    printf '  \xe2\x9c\x93 %s\n' "$1"
  fi
}
fail() {
  if [ "$JSON_MODE" -eq 1 ]; then
    record_json false "$1"
  else
    printf '  \xe2\x9c\x97 %s\n' "$1"
  fi
  fails=$((fails + 1))
}

# --- Check 1: Manifests parse -------------------------------------------------
begin_check 1 "Manifests parse"
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
begin_check 2 "No manifest conflict (marketplace plugin entry vs plugin.json)"
if [ ! -f "$PLUGIN_JSON" ]; then
  pass "plugin.json absent — component-key conflict not possible"
# First require a non-empty plugins array — otherwise `.plugins[0]` is null and
# the `has(...)` probe errors out (swallowed -> misleading PASS).
elif ! jq -e '.plugins | (type == "array") and (length > 0)' \
    "$MARKET_JSON" >/dev/null 2>&1; then
  fail "marketplace.json has no non-empty plugins array"
elif jq -e '.plugins[0] | has("skills") or has("commands") or has("agents")' \
    "$MARKET_JSON" >/dev/null 2>&1; then
  fail "marketplace.json plugins[0] declares skills/commands/agents while plugin.json exists"
else
  pass "marketplace.json plugins[0] declares no component keys"
fi

# --- Check 3: Versions agree --------------------------------------------------
# Read each version via a guarded helper so a missing file or a missing/null key
# becomes a reported Check-3 FAIL rather than aborting the script under `set -e`.
# `jq -r` on an absent key prints literal "null" with rc 0, so we must also
# reject "null"/empty explicitly — otherwise three absent versions would all
# equal "null" and false-pass as a match.
begin_check 3 "Versions agree"
read_version() { # <file> <jq-filter>
  if [ ! -f "$1" ]; then
    echo "<missing-file>"
    return
  fi
  local v
  if ! v="$(jq -r "$2" "$1" 2>/dev/null)"; then
    echo "<jq-error>"
    return
  fi
  echo "$v"
}
v_plugin="$(read_version "$PLUGIN_JSON" '.version')"
v_meta="$(read_version "$MARKET_JSON" '.metadata.version')"
v_entry="$(read_version "$MARKET_JSON" '.plugins[0].version')"
if [ "$JSON_MODE" -eq 0 ]; then
  echo "      plugin.json .version                  = $v_plugin"
  echo "      marketplace.json .metadata.version    = $v_meta"
  echo "      marketplace.json .plugins[0].version  = $v_entry"
fi
v3_bad=""
for v in "$v_plugin" "$v_meta" "$v_entry"; do
  case "$v" in
    "" | "null" | "<missing-file>" | "<jq-error>") v3_bad="yes" ;;
  esac
done
if [ -n "$v3_bad" ]; then
  fail "one or more versions are absent/null/unreadable"
elif [ "$v_plugin" = "$v_meta" ] && [ "$v_meta" = "$v_entry" ]; then
  pass "all three versions match ($v_plugin)"
else
  fail "version mismatch across manifests"
fi

# --- Check 4: Embedded Workflow JS parses -------------------------------------
begin_check 4 "Embedded Workflow JS parses"
# `mktemp --suffix=` is a GNU coreutils extension (present on the Ubuntu CI
# runner). The script also advertises local use; on BSD/macOS mktemp this flag
# would need adjusting.
TMP_JS="$(mktemp --suffix=.js)"
TMP_ERR="$(mktemp)"
trap 'rm -f "$TMP_JS" "$TMP_ERR" "$JSON_TMP"' EXIT

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
  # Strip the leading `export const meta = { ... }` object literal, then validate
  # the remaining script body parses as an async function body.
  #
  # META-BLOCK CONTRACT (required for the strip regex below to be correct):
  #   - `export const meta = {` MUST be the first line of the ```js block.
  #   - The object's closing brace MUST be a line that is exactly `}` at
  #     column 0 (no trailing comment, no indentation) — it terminates the strip.
  #   - No inner property may place a `}` alone at column 0 (would truncate early).
  #   - Line endings MUST be LF (the `\n}\n` anchor assumes Unix newlines; CRLF
  #     would leave a stray `\r` and break the match).
  if node -e "const src=require('fs').readFileSync('$TMP_JS','utf8').replace(/^export const meta[\s\S]*?\n}\n/,''); new Function('args','agent','parallel','pipeline','log','budget','return (async()=>{'+src+'})()');" 2>"$TMP_ERR"; then
    pass "Workflow JS body parses as an async function body"
  else
    fail "Workflow JS body failed to parse: $(head -1 "$TMP_ERR" 2>/dev/null)"
  fi
fi

# --- Check 5: No resume-breaking tokens in the JS block -----------------------
begin_check 5 "No resume-breaking tokens in Workflow JS"
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
begin_check 6 "Example config valid"
if jq empty "$CONFIG_JSON" 2>/dev/null; then
  pass "ultraswarm.config.example.json is valid JSON"
else
  fail "ultraswarm.config.example.json is not valid JSON"
fi

# --- Check 7: Skill frontmatter present ---------------------------------------
begin_check 7 "Skill frontmatter present"
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

# --- Check 8: Router module syntax --------------------------------------------
begin_check 8 "Router module syntax"
if [ ! -f "$ROUTER_MJS" ]; then
  fail "scripts/router.mjs does not exist"
else
  if node --check "$ROUTER_MJS" 2>/dev/null; then
    pass "scripts/router.mjs syntax OK"
  else
    fail "scripts/router.mjs failed syntax check"
  fi
fi

# --- Check 9: Router test suite -----------------------------------------------
begin_check 9 "Router test suite"
if [ ! -f "$ROUTER_TEST" ]; then
  fail "scripts/router.test.mjs does not exist"
else
  if node --test "$ROUTER_TEST" >/dev/null 2>&1; then
    pass "scripts/router.test.mjs tests passed"
  else
    fail "scripts/router.test.mjs tests failed"
  fi
fi

# --- Check 10: Advanced config validates --------------------------------------
begin_check 10 "Advanced config validates"
if [ ! -f "$ADV_CFG" ]; then
  fail "ultraswarm.config.advanced.json does not exist"
elif [ ! -f "$ROUTER_MJS" ]; then
  fail "scripts/router.mjs does not exist (needed for config validation)"
else
  if node -e '
Promise.all([import(process.argv[1]), import("node:fs")]).then(([m, fs]) => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const v = m.validateConfig(cfg);
  if (!v.valid) { console.error(v.errors.join("; ")); process.exit(1); }
  process.exit(0);
});
' "$ROUTER_MJS" "$ADV_CFG" 2>/dev/null; then
    pass "ultraswarm.config.advanced.json passes validateConfig"
  else
    fail "ultraswarm.config.advanced.json failed validateConfig"
  fi
fi

# --- Check 11: Workflow behavior harness ---------------------------------------
begin_check 11 "Workflow behavior harness"
if [ ! -f "$WORKFLOW_TEST" ]; then
  fail "scripts/workflow-harness.test.mjs does not exist"
else
  if node --test "$WORKFLOW_TEST" >/dev/null 2>&1; then
    pass "embedded Workflow JS behavior tests passed"
  else
    fail "embedded Workflow JS behavior tests failed"
  fi
fi

# --- Check 12: Standalone runner + lib module syntax -------------------------
begin_check 12 "Standalone runner and lib modules parse (node --check)"
syntax_fail=""
for f in "$ROOT/bin/ultraswarm.mjs" $(find "$ROOT/lib" -name '*.mjs' | sort); do
  if ! node --check "$f" 2>/dev/null; then
    fail "syntax error in $f"
    syntax_fail=yes
  fi
done
if [ -z "$syntax_fail" ]; then
  pass "bin/ultraswarm.mjs and all lib/**/*.mjs pass node --check"
fi

# --- Summary ------------------------------------------------------------------
if [ "$JSON_MODE" -eq 1 ]; then
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8").trim();
    const arr = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
    console.log(JSON.stringify(arr));
  ' "$JSON_TMP"
  if [ "$fails" -eq 0 ]; then
    exit 0
  else
    exit 1
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  printf '\xe2\x9c\x93 All checks passed.\n'
  exit 0
else
  printf '\xe2\x9c\x97 %d check(s) failed.\n' "$fails"
  exit 1
fi
