#!/usr/bin/env bash
# Fixture build tests for the declaration contracts of zenkaku.build.ts:
# conditionals input errors, duplicate merging, conflict errors, acceptance
# surface, and keys input errors and completeness. Each fixture is a minimal
# declaration fed through --declaration; a case checks the build exit code
# and the generated dictionary or runtime records. Run with:
# bash tests/zenkaku_build.test.sh
set -euo pipefail

rime_dir="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-zenkaku-build-test.XXXXXXXX")"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }

keys_block="$(awk '/^keys:/,0' "$rime_dir/zenkaku.data.yaml")"
[ -n "$keys_block" ] || { echo "cannot extract the keys block from zenkaku.data.yaml" >&2; exit 1; }
declared_keys="$(awk '/^keys:/{f = 1; next} f && NF {c++} END {print c + 0}' "$rime_dir/zenkaku.data.yaml")"

fixture="$scratch/fixture.yaml"
output="$scratch/output.dict.yaml"
rules="$scratch/lua/kagiroi/zenkaku_rules.lua"
text="$scratch/lua/kagiroi/zenkaku_text.lua"

passes=0
failures=0

header="name: kagiroi_dotfiles_zenkaku_test
rows:
  k: [か, き, く, け, こ]
singles:
  nn: ん
families: []
postroma: []"

make_fixture() {
    printf '%s\n%s\n%s\n' "$header" "$1" "$keys_block" > "$fixture"
}

make_fixture_with_keys() {
    printf '%s\n%s\n%s\n' "$header" 'conditionals: []' "$1" > "$fixture"
}

run_build() {
    bun "$rime_dir/zenkaku.build.ts" --declaration "$fixture" --output "$output"
}

assert_build_succeeds() {
    local label="$1" err
    if err="$(run_build 2>&1 >/dev/null)"; then
        passes=$((passes + 1))
    else
        echo "FAIL: $label: build failed:" >&2
        sed 's/^/    /' <<<"$err" >&2
        failures=$((failures + 1))
    fi
}

assert_build_fails_with() {
    local label="$1" message="$2" err
    if err="$(run_build 2>&1 >/dev/null)"; then
        echo "FAIL: $label: build succeeded, expected failure with \"$message\"" >&2
        failures=$((failures + 1))
    elif grep -qF -- "$message" <<<"$err"; then
        passes=$((passes + 1))
    else
        echo "FAIL: $label: build failed without \"$message\":" >&2
        sed 's/^/    /' <<<"$err" >&2
        failures=$((failures + 1))
    fi
}

assert_contains() {
    local label="$1" file="$2" needle="$3"
    if grep -qF -- "$needle" "$file"; then
        passes=$((passes + 1))
    else
        echo "FAIL: $label: '$needle' not found in $file" >&2
        failures=$((failures + 1))
    fi
}

assert_not_contains() {
    local label="$1" file="$2" needle="$3"
    if grep -qF -- "$needle" "$file"; then
        echo "FAIL: $label: '$needle' found in $file" >&2
        failures=$((failures + 1))
    else
        passes=$((passes + 1))
    fi
}

assert_line_count() {
    local label="$1" file="$2" pattern="$3" expected="$4" count
    count="$(grep -cE -- "$pattern" "$file" || true)"
    if [ "$count" -eq "$expected" ]; then
        passes=$((passes + 1))
    else
        echo "FAIL: $label: expected $expected match(es) of '$pattern' in $file, got $count" >&2
        failures=$((failures + 1))
    fi
}

# ---------- C1: conditionals input error contract ----------

make_fixture ""
assert_build_fails_with "C1 missing conditionals" "conditionals must be a list"

make_fixture "conditionals: 3"
assert_build_fails_with "C1 conditionals not a list" "conditionals must be a list"

make_fixture "conditionals:
  - { when_before: [\$same], to: っ }"
assert_build_fails_with "C1 missing from" "conditionals.from must be a nonempty list of single lowercase letters"

make_fixture "conditionals:
  - { from: [k], to: っ }"
assert_build_fails_with "C1 missing when_before" "conditionals.when_before must be a nonempty list of single lowercase letters, \$same, or \$convert"

make_fixture "conditionals:
  - { from: [k], when_before: [\$same] }"
assert_build_fails_with "C1 missing to" "conditionals.to must be a nonempty string"

make_fixture "conditionals:
  - { from: [K], when_before: [\$same], to: っ }"
assert_build_fails_with "C1 invalid from value" "conditionals.from must be a nonempty list of single lowercase letters"

make_fixture "conditionals:
  - { from: [k], when_before: [\$same], to: っ, note: x }"
assert_build_fails_with "C1 unknown field" "must be mappings of from, when_before, to"

make_fixture "conditionals:
  - { from: [k], when_before: [\$other], to: っ }"
assert_build_fails_with "C1 invalid reserved word" "conditionals.when_before must be a nonempty list of single lowercase letters, \$same, or \$convert"

make_fixture "prefixes: {}"
assert_build_fails_with "C1 prefixes rejected" "prefixes is not supported"

# ---------- C2: equal duplicate merging ----------

make_fixture "conditionals:
  - { from: [k], when_before: [\$same], to: っ }
  - { from: [k], when_before: [\$same], to: っ }"
assert_build_succeeds "C2 equal dictionary duplicates"
assert_line_count "C2 merged dictionary record" "$output" $'^っk\tkk\t1$' 1

make_fixture "conditionals:
  - { from: [n], when_before: [\$convert], to: ん }
  - { from: [n], when_before: [\$convert], to: ん }"
assert_build_succeeds "C2 equal convert duplicates"
assert_line_count "C2 merged pending entry" "$rules" '^[[:space:]]+\["n"\] = "ん",' 1

# ---------- C3: conflict errors ----------

make_fixture "conditionals:
  - { from: [k], when_before: [\$same], to: っ }
  - { from: [k], when_before: [\$same], to: く }"
assert_build_fails_with "C3 generated mapping conflict" "conflicting mapping"

make_fixture "conditionals:
  - { from: [n], when_before: [\$convert], to: ん }
  - { from: [n], when_before: [\$convert], to: ぬ }"
assert_build_fails_with "C3 convert mapping conflict" "conflicting convert mapping"

# ---------- C4: conditionals acceptance surface ----------

make_fixture "conditionals: []"
assert_build_succeeds "C4 empty conditionals accepted"
assert_contains "C4 empty pending stays empty" "$rules" "    pending = {
    },"

make_fixture "conditionals:
  - { from: [k], when_before: [\$same, \$convert], to: っ }"
assert_build_succeeds "C4 letter condition and convert combined"
assert_line_count "C4 letter record from combined entry" "$output" $'^っk\tkk\t1$' 1
assert_contains "C4 pending entry from combined entry" "$rules" '["k"] = "っ"'

# ---------- keys: input error contract and completeness ----------

make_fixture "conditionals: []"
assert_build_succeeds "keys complete declaration builds"
assert_line_count "keys completeness: every key lands in zenkaku_text.lua" "$text" '\[0x[0-9a-f]{4}\] = "' "$declared_keys"
assert_contains "keys sample value" "$text" '[0xffb0] = "0"'

make_fixture_with_keys "$(grep -v 'KP_Equal' <<<"$keys_block")"
assert_build_fails_with "keys missing key" "keys is missing keys"

make_fixture_with_keys "$keys_block"$'\n  KB_Equal: "="'
assert_build_fails_with "keys unknown key" "keys has unknown keys"

make_fixture_with_keys "$(sed 's/^  "1":.*/  "1": ""/' <<<"$keys_block")"
assert_build_fails_with "keys empty value" "must be a nonempty string"

echo "zenkaku build contract tests: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
