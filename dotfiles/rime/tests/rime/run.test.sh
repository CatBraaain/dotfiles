#!/usr/bin/env bash
# Regression test for tests/rime/run.sh: per-invocation private workspace,
# RIME_SHARED_DATA forwarding, self-cleanup, overlapping runs, failure
# propagation and option handling. Uses stub cc/bun and a stub mirror so no
# real librime deploy runs here. Run with: bash tests/rime/run.test.sh
set -u

run_sh="$(cd "$(dirname "$0")" && pwd)/run.sh"
export REAL_BUN
REAL_BUN="$(command -v bun)"
export MANAGED_RIME_ROOT
MANAGED_RIME_ROOT="$(cd "$(dirname "$run_sh")/../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-rime-test-self.XXXXXXXX")"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT
trap 'exit 130' INT

mkdir -p "$scratch/fake-bin" "$scratch/mirror/lua/kagiroi" "$scratch/mirror/opencc" \
    "$scratch/shared-a" "$scratch/shared b"
for stock_file in kagiroi.schema.yaml kagiroi.yaml kagiroi.manual.dict.yaml \
    kagiroi.mozc.dict.yaml kagiroi.nico.dict.yaml kagiroi_kanji.dict.yaml \
    kagiroi_kanji.schema.yaml kagiroi_kaomoji.dict.yaml kagiroi_symbols.dict.yaml \
    kagiroi_romaji.dict.yaml kagiroi_romaji.schema.yaml kagiroi_ansikana.dict.yaml \
    kagiroi_ansikana.schema.yaml kagiroi_szromaji.dict.yaml \
    kagiroi_szromaji.schema.yaml kagiroi_matrix.dict.yaml \
    kagiroi_matrix.schema.yaml kagiroi_custom_phrases.txt; do
    echo "stub $stock_file" >"$scratch/mirror/$stock_file"
done
echo 'return {}' >"$scratch/mirror/lua/kagiroi/stock.lua"
echo stub >"$scratch/mirror/opencc/data.txt"

cat >"$scratch/fake-bin/cc" <<'STUB_CC'
#!/usr/bin/env bash
set -euo pipefail
out=""
prev=""
for argument in "$@"; do
    if [ "$prev" = "-o" ]; then out="$argument"; fi
    prev="$argument"
done
[ -n "$out" ] || { echo "stub cc: no -o target" >&2; exit 1; }
if [[ "$out" == */harness-format-test ]]; then
    printf '#!/usr/bin/env bash\nexit 0\n' > "$out"
    chmod +x "$out"
    exit 0
fi
cat > "$out" <<'STUB_HARNESS'
#!/usr/bin/env bash
set -u
user="$1"
printf 'run:user=%s shared=%s\n' "$user" "${RIME_SHARED_DATA:-<unset>}" >> "$FAKE_LOG"
: > "$user/.harness-started"
[ -f "$user/.rime-test-workspace" ] || { echo "private workspace marker missing" >&2; exit 5; }
if compgen -G "$user"/*.userdb >/dev/null; then
    echo "userdb leaked into the fresh workspace" >&2
    exit 4
fi
[ -f "$user/default.custom.yaml" ] || { echo "managed files missing" >&2; exit 3; }
[ -f "$user/kagiroi_dotfiles_zenkaku.dict.yaml" ] || { echo "generated dict missing" >&2; exit 3; }
[ -f "$user/lua/rime_snapshot.lua" ] || { echo "snapshot observer missing" >&2; exit 3; }
for file in "$MANAGED_RIME_ROOT"/lua/kagiroi/*.lua; do
    cmp "$file" "$user/lua/kagiroi/$(basename "$file")" || exit 3
done
"$REAL_BUN" --eval '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const original = Bun.YAML.parse(readFileSync(process.env.MANAGED_RIME_ROOT + "/kagiroi.custom.yaml", "utf8"));
    const observed = Bun.YAML.parse(readFileSync(process.argv.at(-1), "utf8"));
    assert.equal(observed.patch["engine/processors"].shift(), "lua_processor@*rime_snapshot");
    assert.deepEqual(observed, original);
' "$user/kagiroi.custom.yaml" || exit 3
if [ -n "${FAKE_HARNESS_RELEASE:-}" ]; then
    waited=0
    until [ -e "$FAKE_HARNESS_RELEASE" ] || [ "$waited" -ge 300 ]; do
        sleep 0.1
        waited=$((waited + 1))
    done
fi
exit "${FAKE_HARNESS_EXIT:-0}"
STUB_HARNESS
chmod +x "$out"
STUB_CC
chmod +x "$scratch/fake-bin/cc"

cat >"$scratch/fake-bin/bun" <<'STUB_BUN'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--eval" ]; then exec "$REAL_BUN" "$@"; fi
out=""
prev=""
for argument in "$@"; do
    if [ "$prev" = "--output" ]; then out="$argument"; fi
    prev="$argument"
done
[ -n "$out" ] || { echo "stub bun: no --output target" >&2; exit 1; }
printf 'stub-generated-romaji\n' > "$out"
STUB_BUN
chmod +x "$scratch/fake-bin/bun"

fails=0
pass() { echo "ok:   $1"; }
fail() {
    echo "FAIL: $1"
    fails=$((fails + 1))
}
assert() {
    local name="$1"
    shift
    if "$@"; then pass "$name"; else fail "$name"; fi
}
refute() {
    local name="$1"
    shift
    if "$@"; then fail "$name"; else pass "$name"; fi
}
leftovers_in() {
    find "$1" -maxdepth 1 -name 'dotfiles-rime-test.*' -print -quit
}
wait_for_run_log() {
    waited=0
    until grep -q '^run:' "$1" || [ "$waited" -ge 100 ]; do
        sleep 0.1
        waited=$((waited + 1))
    done
}
logged_user_from() {
    local line
    line="$(grep '^run:' "$1" | head -1 || true)"
    line="${line#run:user=}"
    printf '%s' "${line%% *}"
}

tmp="$(mktemp -d "$scratch/tmp.XXXXXXXX")"
log="$scratch/contract.log"
: >"$log"

status=0
env TMPDIR="$tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$log" \
    bash "$run_sh" >"$scratch/t1.out" 2>&1 || status=$?
assert "t1: run.sh exits 0" [ "$status" = 0 ]
assert "t1: harness ran once" [ "$(grep -c '^run:' "$log")" = 1 ]
assert "t1: workspace is a fresh private dir under TMPDIR" \
    grep -q "^run:user=$tmp/dotfiles-rime-test\." <(grep '^run:' "$log")
assert "t1: RIME_SHARED_DATA override forwarded" \
    grep -q "shared=$scratch/shared-a$" "$log"
assert "t1: own workspace removed after exit" [ -z "$(leftovers_in "$tmp")" ]

if [ -d /usr/share/rime-data ]; then
    status=0
    env -u RIME_SHARED_DATA TMPDIR="$tmp" PATH="$scratch/fake-bin:$PATH" \
        KAGIROI_MIRROR="$scratch/mirror" FAKE_LOG="$log" \
        bash "$run_sh" >"$scratch/t2.out" 2>&1 || status=$?
    assert "t2: default run exits 0" [ "$status" = 0 ]
    assert "t2: default shared data forwarded" \
        grep -q 'shared=/usr/share/rime-data$' "$log"
else
    echo "ok:   t2: skipped (no /usr/share/rime-data on this machine)"
fi

space_tmp="$tmp/sp ace"
mkdir -p "$space_tmp"
status=0
env TMPDIR="$space_tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared b" FAKE_LOG="$log" \
    bash "$run_sh" >"$scratch/t3.out" 2>&1 || status=$?
assert "t3: run.sh works with spaces in TMPDIR and shared data" [ "$status" = 0 ]
assert "t3: shared override with space forwarded intact" \
    grep -q "shared=$scratch/shared b$" "$log"
assert "t3: spaced workspace removed" [ -z "$(leftovers_in "$space_tmp")" ]

overlap_tmp="$(mktemp -d "$scratch/tmp.XXXXXXXX")"
overlap_log="$scratch/overlap.log"
: >"$overlap_log"
release="$scratch/overlap-release"
env TMPDIR="$overlap_tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$overlap_log" \
    FAKE_HARNESS_RELEASE="$release" \
    bash "$run_sh" >"$scratch/t4a.out" 2>&1 &
slow_pid=$!
wait_for_run_log "$overlap_log"
slow_user="$(logged_user_from "$overlap_log")"
status=0
env TMPDIR="$overlap_tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$overlap_log" \
    bash "$run_sh" >"$scratch/t4b.out" 2>&1 || status=$?
assert "t4: overlapping fast run exits 0" [ "$status" = 0 ]
assert "t4: fast run left the live slow workspace untouched" \
    test -n "$slow_user" -a -d "$slow_user" -a -f "$slow_user/.harness-started"
: >"$release"
slow_status=0
wait "$slow_pid" || slow_status=$?
assert "t4: released slow run exits 0" [ "$slow_status" = 0 ]
assert "t4: both harnesses ran" [ "$(grep -c '^run:' "$overlap_log")" = 2 ]
assert "t4: workspaces were distinct private dirs" \
    [ "$(grep '^run:' "$overlap_log" | sort -u | wc -l)" = 2 ]
assert "t4: all workspaces removed after both runs" \
    [ -z "$(leftovers_in "$overlap_tmp")" ]

fail_tmp="$(mktemp -d "$scratch/tmp.XXXXXXXX")"
fail_log="$scratch/fail.log"
: >"$fail_log"
status=0
env TMPDIR="$fail_tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$fail_log" FAKE_HARNESS_EXIT=1 \
    bash "$run_sh" >"$scratch/t5.out" 2>&1 || status=$?
assert "t5: harness failure propagates" [ "$status" = 1 ]
assert "t5: failed run workspace still removed" [ -z "$(leftovers_in "$fail_tmp")" ]

status=0
env TMPDIR="$tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$log" \
    bash "$run_sh" --clean >"$scratch/t6.out" 2>&1 || status=$?
assert "t6: --clean accepted and run exits 0" [ "$status" = 0 ]
assert "t6: no shared cache left behind" [ -z "$(leftovers_in "$tmp")" ]

if command -v timeout >/dev/null; then
    term_tmp="$(mktemp -d "$scratch/tmp.XXXXXXXX")"
    term_log="$scratch/term.log"
    : >"$term_log"
    status=0
    env TMPDIR="$term_tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
        RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$term_log" \
        FAKE_HARNESS_RELEASE="$scratch/never-released" \
        timeout -k 2s 2s bash "$run_sh" >"$scratch/t8.out" 2>&1 || status=$?
    assert "t8: timed-out run reports 124" [ "$status" = 124 ]
    assert "t8: group TERM cleanup removes the own workspace" \
        [ -z "$(leftovers_in "$term_tmp")" ]
else
    echo "ok:   t8: skipped (no timeout command)"
fi

status=0
env TMPDIR="$tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/shared-a" FAKE_LOG="$log" \
    bash "$run_sh" --bogus >"$scratch/t7.out" 2>&1 || status=$?
assert "t7: unknown option rejected with 2" [ "$status" = 2 ]
status=0
env TMPDIR="$tmp" PATH="$scratch/fake-bin:$PATH" KAGIROI_MIRROR="$scratch/mirror" \
    RIME_SHARED_DATA="$scratch/no-such-dir" FAKE_LOG="$log" \
    bash "$run_sh" >"$scratch/t7b.out" 2>&1 || status=$?
assert "t7: missing shared data dir rejected with 1" [ "$status" = 1 ]
assert "t7: missing shared data reported" \
    grep -q 'Rime shared data not found' "$scratch/t7b.out"

echo "----"
if [ "$fails" = 0 ]; then
    echo "all run.sh contract tests passed"
else
    echo "$fails run.sh contract test(s) failed"
    exit 1
fi
