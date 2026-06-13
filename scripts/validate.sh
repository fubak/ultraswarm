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
CODEX_SKILL_MD="$ROOT/hosts/codex/skills/ultraswarm/SKILL.md"
CODEX_INSTALLER="$ROOT/scripts/install-codex-skill.sh"
PACKAGE_JSON="$ROOT/package.json"
PACKAGE_LOCK_JSON="$ROOT/package-lock.json"
CONFIG_JSON="$ROOT/ultraswarm.config.example.json"
ROUTER_MJS="$ROOT/lib/router.mjs"
ROUTER_TEST="$ROOT/lib/router.test.mjs"
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
v_package="$(read_version "$PACKAGE_JSON" '.version')"
v_lock="$(read_version "$PACKAGE_LOCK_JSON" '.packages[""].version')"
if [ "$JSON_MODE" -eq 0 ]; then
  echo "      plugin.json .version                  = $v_plugin"
  echo "      marketplace.json .metadata.version    = $v_meta"
  echo "      marketplace.json .plugins[0].version  = $v_entry"
  echo "      package.json .version                 = $v_package"
  echo "      package-lock.json root .version       = $v_lock"
fi
v3_bad=""
for v in "$v_plugin" "$v_meta" "$v_entry" "$v_package" "$v_lock"; do
  case "$v" in
    "" | "null" | "<missing-file>" | "<jq-error>") v3_bad="yes" ;;
  esac
done
if [ -n "$v3_bad" ]; then
  fail "one or more versions are absent/null/unreadable"
elif [ "$v_plugin" = "$v_meta" ] && [ "$v_meta" = "$v_entry" ] && [ "$v_entry" = "$v_package" ] && [ "$v_package" = "$v_lock" ]; then
  pass "plugin and npm package versions match ($v_plugin)"
else
  fail "version mismatch across plugin and npm manifests"
fi

# --- Check 4: Generated host skills are current -------------------------------
begin_check 4 "Generated host skill provenance"
if node "$ROOT/scripts/generate-host-skills.mjs" --check 2>/dev/null; then
  pass "generated host skills match their SHA-256 lock"
else
  fail "generated host skills or provenance lock are stale"
fi

# --- Check 5: Skills are thin runner adapters ---------------------------------
begin_check 5 "Host skills are thin runner adapters"
if grep -q "standalone runner as the only orchestration implementation" "$SKILL_MD"; then
  pass "host skills delegate orchestration to the standalone runner"
else
  fail "Claude skill is not a generated thin runner adapter"
fi

# --- Check 6: Example config valid --------------------------------------------
begin_check 6 "Example config valid"
if jq empty "$CONFIG_JSON" 2>/dev/null; then
  pass "ultraswarm.config.example.json is valid JSON"
else
  fail "ultraswarm.config.example.json is not valid JSON"
fi

# --- Check 7: Host skill frontmatter present ----------------------------------
begin_check 7 "Claude Code and Codex skill frontmatter"
for skill_file in "$SKILL_MD" "$CODEX_SKILL_MD"; do
  skill_label="${skill_file#"$ROOT/"}"
  if [ ! -f "$skill_file" ]; then
    fail "$skill_label does not exist"
    continue
  fi
  first_line="$(head -n 1 "$skill_file")"
  if [ "$first_line" != "---" ]; then
    fail "$skill_label first line is not '---' (got '$first_line')"
    continue
  fi
  fm="$(awk 'NR==1{next} /^---$/{exit} {print}' "$skill_file")"
  if printf '%s\n' "$fm" | grep -q '^name: ultraswarm$' && \
     printf '%s\n' "$fm" | grep -q '^description:'; then
    pass "$skill_label has ultraswarm name and description"
  else
    fail "$skill_label frontmatter is missing name: ultraswarm or description:"
  fi
done

# --- Check 8: Router module syntax --------------------------------------------
begin_check 8 "Router module syntax"
if [ ! -f "$ROUTER_MJS" ]; then
  fail "lib/router.mjs does not exist"
else
  if node --check "$ROUTER_MJS" 2>/dev/null; then
    pass "lib/router.mjs syntax OK"
  else
    fail "lib/router.mjs failed syntax check"
  fi
fi

# --- Check 9: Router test suite -----------------------------------------------
begin_check 9 "Router test suite"
if [ ! -f "$ROUTER_TEST" ]; then
  fail "lib/router.test.mjs does not exist"
else
  if node --test "$ROUTER_TEST" >/dev/null 2>&1; then
    pass "lib/router.test.mjs tests passed"
  else
    fail "lib/router.test.mjs tests failed"
  fi
fi

# --- Check 10: Advanced config validates --------------------------------------
begin_check 10 "Advanced config validates"
if [ ! -f "$ADV_CFG" ]; then
  fail "ultraswarm.config.advanced.json does not exist"
elif [ ! -f "$ROUTER_MJS" ]; then
  fail "lib/router.mjs does not exist (needed for config validation)"
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

# --- Check 11: Host contract behavior harness ---------------------------------------
begin_check 11 "Host contract behavior harness"
if [ ! -f "$WORKFLOW_TEST" ]; then
  fail "scripts/workflow-harness.test.mjs does not exist"
else
  if node --test "$WORKFLOW_TEST" >/dev/null 2>&1; then
    pass "host contract parity tests passed"
  else
    fail "host contract parity tests failed"
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

# --- Check 13: Codex skill contract ------------------------------------------
begin_check 13 "Codex skill contract"
codex_contract_bad=""
for required in '$ultraswarm' 'run --plan-file .ultraswarm-plan.json' '--approve-plan' 'merge <run-id> --approve' 'separate merge approval'; do
  if ! grep -q -- "$required" "$CODEX_SKILL_MD" 2>/dev/null; then
    fail "Codex skill is missing required contract text: $required"
    codex_contract_bad=yes
  fi
done
if [ -z "$codex_contract_bad" ]; then
  pass "Codex skill defines runner delegation and both approval gates"
fi

# --- Check 14: Codex installer ------------------------------------------------
begin_check 14 "Codex skill installer"
if ! bash -n "$CODEX_INSTALLER" 2>/dev/null; then
  fail "scripts/install-codex-skill.sh failed bash syntax check"
else
  install_tmp="$(mktemp -d)"
  if CODEX_SKILLS_DIR="$install_tmp/skills" bash "$CODEX_INSTALLER" >/dev/null 2>&1 && \
     [ -L "$install_tmp/skills/ultraswarm" ] && \
     [ "$(readlink -f "$install_tmp/skills/ultraswarm")" = "$(readlink -f "$ROOT/hosts/codex/skills/ultraswarm")" ] && \
     CODEX_SKILLS_DIR="$install_tmp/skills" bash "$CODEX_INSTALLER" >/dev/null 2>&1; then
    pass "installer creates the ~/.agents-compatible symlink and is idempotent"
  else
    fail "installer smoke test failed"
  fi
  rm -rf "$install_tmp"
fi

# --- Check 15: Host installation docs ----------------------------------------
begin_check 15 "Host-specific installation docs"
docs_bad=""
for required in '~/.agents/skills' 'scripts/install-codex-skill.sh' '\$ultraswarm' '/ultraswarm'; do
  if ! grep -q -- "$required" "$ROOT/README.md"; then
    fail "README is missing host installation guidance: $required"
    docs_bad=yes
  fi
done
if grep -q '~/.codex/skills/ultraswarm' "$ROOT/README.md"; then
  fail "README still recommends the obsolete Codex skill directory"
  docs_bad=yes
fi
if [ -z "$docs_bad" ]; then
  pass "README distinguishes Codex and Claude Code installation and invocation"
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
