#!/usr/bin/env bash
# Build and run the headless librime behavior harness for the managed Kagiroi
# config. The workspace under /tmp mirrors the deployed layout: managed files
# from dotfiles/rime and stock Kagiroi files from the local mirror. The
# deploy cache is reused across runs; pass --clean to rebuild it.
# Options: --clean  rebuild the workspace from scratch
#          --verbose print compositions and candidate menus
set -euo pipefail

mirror="${KAGIROI_MIRROR:-$HOME/mirrors/github.com/rimeinn/rime-kagiroi}"
shared="${RIME_SHARED_DATA:-/usr/share/rime-data}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

clean=0
harness_args=()
for argument in "$@"; do
    case "$argument" in
        --clean) clean=1 ;;
        --verbose) harness_args+=(-v) ;;
        *) echo "unknown option: $argument" >&2; exit 2 ;;
    esac
done

command -v cc >/dev/null || { echo "cc is required" >&2; exit 1; }
if pkg-config --exists rime; then
    rime_cflags="$(pkg-config --cflags rime)"
    rime_libs="$(pkg-config --libs rime)"
else
    # librime-dev is missing; the stock headers from the librime mirror are
    # ABI-compatible with the installed runtime.
    mirror_headers="$HOME/mirrors/github.com/rime/librime/src"
    if [ -f "$mirror_headers/rime_api.h" ] && [ -f /usr/lib/x86_64-linux-gnu/librime.so.1 ]; then
        rime_cflags="-I$mirror_headers"
        rime_libs="-l:librime.so.1"
    else
        echo "librime-dev is required (pkg-config 'rime' not found); run: just install" >&2
        exit 1
    fi
fi
[ -d "$mirror" ] || { echo "Kagiroi mirror not found: $mirror" >&2; exit 1; }
[ -d "$shared" ] || { echo "Rime shared data not found: $shared" >&2; exit 1; }

cache="${TMPDIR:-/tmp}/dotfiles-rime-test"
if [ "$clean" = 1 ]; then rm -rf "$cache"; fi
workspace="$cache/user"
mkdir -p "$cache/harness" "$workspace/lua/kagiroi"

# Stock Kagiroi files first, so the managed files always win.
# The main kagiroi dictionary imports the mozc, nico and manual tables, and
# kagiroi.yaml carries the alphabet/key_bindings/punct nodes the schema includes.
# The dependency schemas are needed so their dictionaries get prism/reverse tables.
install -m 644 "$mirror"/kagiroi.schema.yaml "$mirror"/kagiroi.yaml \
    "$mirror"/kagiroi.dict.yaml "$mirror"/kagiroi.manual.dict.yaml \
    "$mirror"/kagiroi.mozc.dict.yaml "$mirror"/kagiroi.nico.dict.yaml \
    "$mirror"/kagiroi_kanji.dict.yaml "$mirror"/kagiroi_kanji.schema.yaml \
    "$mirror"/kagiroi_kaomoji.dict.yaml "$mirror"/kagiroi_symbols.dict.yaml \
    "$mirror"/kagiroi_romaji.dict.yaml "$mirror"/kagiroi_romaji.schema.yaml \
    "$mirror"/kagiroi_ansikana.dict.yaml "$mirror"/kagiroi_ansikana.schema.yaml \
    "$mirror"/kagiroi_szromaji.dict.yaml "$mirror"/kagiroi_szromaji.schema.yaml \
    "$mirror"/kagiroi_matrix.dict.yaml "$mirror"/kagiroi_matrix.schema.yaml \
    "$mirror"/punctuation.yaml \
    "$mirror"/key_bindings.yaml "$mirror"/kagiroi_custom_phrases.txt "$workspace/"
cp -r "$mirror"/lua/kagiroi/. "$workspace/lua/kagiroi/"
cp -r "$mirror"/opencc "$workspace/"

# Managed files under test, in the same relative layout as the deployment.
# The romaji dictionary is generated from the declaration, as in dist/.
install -m 644 "$root"/default.custom.yaml "$root"/kagiroi.custom.yaml \
    "$root"/kagiroi.custom.dict.yaml "$root"/kagiroi_romaji.custom.yaml "$workspace/"
bun "$root/roma.build.ts" --output "$workspace/kagiroi_dotfiles_romaji.dict.yaml"
install -m 644 "$root"/lua/kagiroi/*.lua "$workspace/lua/kagiroi/"

cc -std=c11 -O2 -o "$cache/harness/harness" "$root/tests/rime/harness.c" $rime_cflags $rime_libs
# Learning tests write userdb entries that shift candidate order; start every
# run from a clean slate so the baseline menu is stable.
rm -rf "$workspace"/*.userdb
exec "$cache/harness/harness" "$workspace" "${harness_args[@]}"
