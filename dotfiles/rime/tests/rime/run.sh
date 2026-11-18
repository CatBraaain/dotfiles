#!/usr/bin/env bash
# Build and run the headless librime behavior harness for the managed Kagiroi
# config. The workspace under TMPDIR mirrors the deployed layout: managed
# files from dotfiles/rime and stock Kagiroi files from the local mirror.
# Every invocation deploys into its own private workspace and removes it when
# the run exits.
# Options: --clean  accepted for compatibility; every run deploys from scratch
#          --verbose print compositions and candidate menus
#          --update[=<scenario>|all]
#                  rewrite the guarded snapshots under tests/rime/snapshots/:
#                  no value refreshes existing files, a scenario name adds or
#                  rewrites that one file, and all records every scenario.
set -euo pipefail

mirror="${KAGIROI_MIRROR:-$HOME/mirrors/github.com/rimeinn/rime-kagiroi}"
shared="${RIME_SHARED_DATA:-/usr/share/rime-data}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
snapshots="$root/tests/rime/snapshots"

harness_args=(--snapshot-dir "$snapshots")
for argument in "$@"; do
    case "$argument" in
        --clean) ;;
        --verbose) harness_args+=(-v) ;;
        --update) harness_args+=(--update); mkdir -p "$snapshots" ;;
        --update=*) harness_args+=("$argument"); mkdir -p "$snapshots" ;;
        *) echo "unknown option: $argument" >&2; exit 2 ;;
    esac
done

command -v cc >/dev/null || { echo "cc is required" >&2; exit 1; }
if pkg-config --exists rime; then
    read -r -a rime_cflags <<<"$(pkg-config --cflags rime)"
    read -r -a rime_libs <<<"$(pkg-config --libs rime)"
else
    # librime-dev is missing; the stock headers from the librime mirror are
    # ABI-compatible with the installed runtime.
    mirror_headers="$HOME/mirrors/github.com/rime/librime/src"
    if [ -f "$mirror_headers/rime_api.h" ] && [ -f /usr/lib/x86_64-linux-gnu/librime.so.1 ]; then
        rime_cflags=(-I"$mirror_headers")
        rime_libs=(-l:librime.so.1)
    else
        echo "librime-dev is required (pkg-config 'rime' not found); run: just install" >&2
        exit 1
    fi
fi
[ -d "$mirror" ] || { echo "Kagiroi mirror not found: $mirror" >&2; exit 1; }
[ -d "$shared" ] || { echo "Rime shared data not found: $shared" >&2; exit 1; }
export RIME_SHARED_DATA="$shared"

run="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-rime-test.XXXXXXXX")"
cleanup() { rm -rf "$run"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

workspace="$run/user"
mkdir -p "$workspace/lua/kagiroi"
touch "$workspace/.rime-test-workspace"

# Stock Kagiroi files first, so the managed files always win.
# kagiroi.yaml carries the alphabet/key_bindings/punct nodes the schema includes.
# Common punctuation/key binding presets come from shared data, as in deployment.
# The dependency schemas are needed so their dictionaries get prism/reverse tables.
install -m 644 "$mirror"/kagiroi.schema.yaml "$mirror"/kagiroi.yaml \
    "$mirror"/kagiroi.manual.dict.yaml \
    "$mirror"/kagiroi.mozc.dict.yaml "$mirror"/kagiroi.nico.dict.yaml \
    "$mirror"/kagiroi_kanji.dict.yaml "$mirror"/kagiroi_kanji.schema.yaml \
    "$mirror"/kagiroi_kaomoji.dict.yaml "$mirror"/kagiroi_symbols.dict.yaml \
    "$mirror"/kagiroi_romaji.dict.yaml "$mirror"/kagiroi_romaji.schema.yaml \
    "$mirror"/kagiroi_ansikana.dict.yaml "$mirror"/kagiroi_ansikana.schema.yaml \
    "$mirror"/kagiroi_szromaji.dict.yaml "$mirror"/kagiroi_szromaji.schema.yaml \
    "$mirror"/kagiroi_matrix.dict.yaml "$mirror"/kagiroi_matrix.schema.yaml \
    "$mirror"/kagiroi_custom_phrases.txt "$workspace/"
cp -r "$mirror"/lua/kagiroi/. "$workspace/lua/kagiroi/"
cp -r "$mirror"/opencc "$workspace/"

# Managed files under test, in the same relative layout as the deployment.
# The romaji dictionary is generated from the declaration, as in dist/.
install -m 644 "$root"/default.custom.yaml "$root"/kagiroi.custom.yaml \
    "$root"/kagiroi.dict.yaml "$root"/kagiroi.custom.dict.yaml \
    "$root"/kagiroi_romaji.custom.yaml "$workspace/"
bun "$root/zenkaku.build.ts" --output "$workspace/kagiroi_dotfiles_zenkaku.dict.yaml"
install -m 644 "$root"/lua/kagiroi/*.lua "$workspace/lua/kagiroi/"
install -m 644 "$root/tests/rime/snapshot.lua" "$workspace/lua/rime_snapshot.lua"
bun --eval '
    import { readFileSync, writeFileSync } from "node:fs";
    const path = process.argv.at(-1);
    const schema = Bun.YAML.parse(readFileSync(path, "utf8"));
    schema.patch["engine/processors"].unshift("lua_processor@*rime_snapshot");
    writeFileSync(path, Bun.YAML.stringify(schema));
' "$workspace/kagiroi.custom.yaml"

cc -std=c11 -O2 -o "$run/harness-format-test" "$root/tests/rime/harness.test.c" \
    "${rime_cflags[@]}" "${rime_libs[@]}"
"$run/harness-format-test"
lua5.4 "$root/tests/rime/snapshot.test.lua" "$root/tests/rime/snapshot.lua"
cc -std=c11 -O2 -o "$run/harness" "$root/tests/rime/harness.c" \
    "${rime_cflags[@]}" "${rime_libs[@]}"
# Learning tests write userdb entries that shift candidate order; start every
# run from a clean slate so the baseline menu is stable.
rm -rf "$workspace"/*.userdb
status=0
"$run/harness" "$workspace" "${harness_args[@]}" || status=$?
exit "$status"
