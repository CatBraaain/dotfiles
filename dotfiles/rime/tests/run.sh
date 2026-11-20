#!/usr/bin/env bash
set -euo pipefail

rime_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$rime_dir"

generated="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-rime-unit.XXXXXX")"
cleanup() { rm -rf "$generated"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

bun zenkaku.build.ts --output "$generated/kagiroi_dotfiles_zenkaku.dict.yaml"
bash tests/zenkaku_build.test.sh
lua5.4 tests/candidate_gate.test.lua lua/kagiroi/candidate_gate.lua
lua5.4 tests/rime_controls.test.lua lua/kagiroi/rime_controls.lua "$generated/lua/kagiroi/zenkaku_text.lua"
lua5.4 tests/rime_ascii_toggle.test.lua lua/kagiroi/rime_ascii_toggle.lua lua/kagiroi/rime_controls.lua "$generated/lua/kagiroi/zenkaku_text.lua"
lua5.4 tests/kagiroi_n_kana_speller.test.lua lua/kagiroi/kagiroi_n_kana_speller.lua "$generated/lua/kagiroi/zenkaku_rules.lua" "$generated/kagiroi_dotfiles_zenkaku.dict.yaml"
lua5.4 tests/kagiroi_suffix.test.lua lua/kagiroi/kagiroi_n_kana_speller.lua "$generated/lua/kagiroi/zenkaku_rules.lua"
lua5.4 tests/char_variants.test.lua lua/kagiroi/char_variants.lua
lua5.4 tests/bunsetsu.test.lua lua/kagiroi/bunsetsu.lua
lua5.4 tests/default_config.test.lua default.custom.yaml
lua5.4 tests/weasel_config.test.lua weasel.custom.yaml
lua5.4 tests/fcitx5_config.test.lua ../fcitx5/conf/rime.conf ../remap.data.md
lua5.4 tests/kagiroi_config.test.lua kagiroi.custom.yaml lua/kagiroi/candidate_gate.lua "$generated/lua/kagiroi/zenkaku_text.lua"
bash tests/rime/run.sh
