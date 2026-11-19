# Rime Lua の役割マップ

`dotfiles/rime/lua/kagiroi/` 配下の Lua と、`kagiroi.schema.yaml`・`kagiroi.custom.yaml` への配線を、Rime（Kagiroiスキーマ）の変換の読み手・変更担当者に向けて説明する。出所とライセンスの詳細は同ディレクトリの `provenance.spec.md` を参照する。

## 配備フロー

1. mirror由来の Lua は `dotfiles/rime/lua/kagiroi/` に正本として置き、`external.data.yaml` の `lua` エントリは廃止した。スキーマ・辞書・`opencc`・`kagiroi.ico` は引き続き mirror（rimeinn/rime-kagiroi）から取得する
2. build（`dotfiles-manager`）が `dotfiles/rime` を dist へコピーし、外部取得で mirror の辞書等を重ねる
3. apply が dist を Rime のユーザーディレクトリ（Linux は `~/.local/share/fcitx5/rime`、Windows は `AppData/Roaming/Rime`）へ展開する。`dotfiles/remap.data.md` の `rime` 行の macos列は `-` であり、macOS では dist からこのフォルダ配下が除去され配備されない
4. このディレクトリの `provenance.spec.md` と `role-map.spec.md` は管理文書であり、dist へ展開されない

## ファイルの役割

| ファイル | 出所 | 役割 |
| --- | --- | --- |
| `kagiroi.lua` | mirror | 共通ユーティリティ（UTF-8文字列操作、Thunk など）。他の全 Lua が `require("kagiroi/kagiroi")` で読む |
| `kagiroi_translator.lua` | mirror | 変換の本体。schema の translator として直結し、Viterbi で確定した語経路を Rime 候補へ変換する。user dict への学習記録も担う |
| `kagiroi_viterbi.lua` | mirror | ラティス構築と Viterbi 探索。通常辞書の語経路と連接コスト（`ReverseLookup("kagiroi_matrix")`）から最良経路を求める |
| `segmenter.lua` | mirror | 文節境界判定テーブル。Mozc の `segmenter.def` から自動生成済みで、品詞IDペアが境界になり得るかを返す。`kagiroi_viterbi` と `bunsetsu` が使う |
| `kagiroi_kana_speller.lua` | mirror | ローマ字→かな変換の processor。単体では schema に直結せず、`kagiroi_n_kana_speller` の基底モジュールとして使う |
| `kagiroi_n_kana_speller.lua` | 管理ファイル | n過不足補正つきのかな変換。`zenkaku_rules` の宣言からローマ字表を組み立て、mirror版 `kagiroi_kana_speller` の `init`・`fini` を再利用する |
| `lru.lua` | mirror（第三者・MIT） | LRUキャッシュ。`kagiroi_viterbi` が連接コスト等のキャッシュに使う |
| `priority_queue.lua` | mirror（第三者・zlib） | 優先度付きキュー。`kagiroi_viterbi` のラティス探索に使う |
| `bunsetsu.lua` | 管理ファイル | 文節単位の候補管理・学習・全読みプレビュー。translator・filter・segment の各入口を持つ本体 |
| `bunsetsu_segmentor.lua` | 管理ファイル | `bunsetsu.lua` の segment 入口を segmentor として公開する1行ラッパ |
| `candidate_gate.lua` | 管理ファイル | `_kagiroi_hide_candidates` オプション中は候補一覧を隠す filter |
| `char_variants.lua` | 管理ファイル | 読みを持たない区間（数字・記号・英数）の文字種候補（全角/半角/大文字小文字）を生成する translator |
| `rime_ascii_toggle.lua` | 管理ファイル | 半角/全角・無変換キーによる 日本語入力 ⇔ 未確定ASCII入力 ⇔ IME OFF の切替 processor |
| `rime_controls.lua` | 管理ファイル | 候補表示・Space変換・確定・文節移動などのキー制御の中央 processor。内部で `kagiroi_n_kana_speller` と `bunsetsu` を呼ぶ |
| `dic/kagiroi_id.def`・`dic/matrix_custom.def`・`dic/lex_excluded.csv` | mirror | mirror の Makefile・`tools/` が辞書（`kagiroi.mozc`・`kagiroi_matrix` 等）を生成するときの入力データ。Rime 実行時には参照されない |

## schema への配線

`kagiroi.schema.yaml`（mirror取得）と `kagiroi.custom.yaml`（管理）の Lua 配線。`@*kagiroi/<名前>` は `lua/kagiroi/<名前>.lua` を読む。

| 配線 | モジュール | 定義場所 | 状態 |
| --- | --- | --- | --- |
| `engine/processors`（schema直書き） | `lua_processor@*kagiroi/kagiroi_kana_speller` | `kagiroi.schema.yaml` | `kagiroi.custom.yaml` が processors を丸ごと置換するため置き換わり、同モジュールは `kagiroi_n_kana_speller` の基底として間接にだけ使われる |
| `engine/translators`（schema直書き） | `lua_translator@*kagiroi/kagiroi_translator` | `kagiroi.schema.yaml` | 有効。変換候補の主経路 |
| `engine/processors`（patch） | `lua_processor@*kagiroi/rime_ascii_toggle`、`lua_processor@*kagiroi/rime_controls` | `kagiroi.custom.yaml` | 有効。processors の先頭に置かれる |
| `engine/segmentors/@before 0` | `lua_segmentor@*kagiroi/bunsetsu_segmentor` | `kagiroi.custom.yaml` | 有効。全segmentorより先に走る |
| `engine/translators/@2` | `lua_translator@*kagiroi/bunsetsu` | `kagiroi.custom.yaml` | 有効。文節候補を供給する |
| `engine/translators/@next` | `lua_translator@*kagiroi/char_variants` | `kagiroi.custom.yaml` | 有効。末尾に追加 |
| `engine/filters/@after 1`・`@next` | `lua_filter@*kagiroi/bunsetsu*filter`、`lua_filter@*kagiroi/candidate_gate` | `kagiroi.custom.yaml` | 有効。bunsetsu の候補整形と候補隠し |

## モジュール依存

各モジュールが `require` する同階層のモジュール。`()` 内は読み込み方で、遅延は関数呼び出し時、`pcall` は失敗しても該当機能が無効になるだけで動作する。

| モジュール | 依存先 |
| --- | --- |
| `kagiroi` | なし |
| `kagiroi_kana_speller` | `kagiroi` |
| `kagiroi_n_kana_speller` | `kagiroi_kana_speller`、`zenkaku_rules`（build生成） |
| `kagiroi_translator` | `kagiroi`、`kagiroi_viterbi` |
| `kagiroi_viterbi` | `kagiroi`、`segmenter`、`priority_queue`、`lru` |
| `segmenter`、`lru`、`priority_queue`、`candidate_gate`、`char_variants` | なし |
| `bunsetsu` | `char_variants`、`segmenter`（pcall）、`kagiroi_translator`（`Top.init` で遅延） |
| `bunsetsu_segmentor` | `bunsetsu` |
| `rime_ascii_toggle` | `rime_controls` |
| `rime_controls` | `kagiroi_n_kana_speller`、`bunsetsu`、`zenkaku_text`（build生成） |
