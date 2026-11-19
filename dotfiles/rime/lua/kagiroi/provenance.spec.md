# Kagiroi engine Lua の出所とライセンス

このディレクトリのうち、下表の mirror由来ファイルは [rimeinn/rime-kagiroi](https://github.com/rimeinn/rime-kagiroi) から無改変で取り込んだものである。取り込み後に内容を変更するときは、Kagiroi本体（GPL-3）との差分管理が必要になるため、原則として無改変のまま保つ。

- 出所: rimeinn/rime-kagiroi commit `808a195415e6d7bd3a41b1747039d8459bfde207`（ローカルmirror `~/mirrors/github.com/rimeinn/rime-kagiroi/`）
- 取り込み: 2026-11-19。`lua/kagiroi/` 配下を、このディレクトリへファイル名・内容とも変更せずにコピーした
- このファイルと `role-map.spec.md` は管理文書であり、`dotfiles/remap.data.md` の `**/*.spec.md` により dist へ展開されない。下表の mirror由来ファイルと `dic/`・`LICENSE` は dist へ展開される

| ファイル | 役割 | ライセンス |
| --- | --- | --- |
| `kagiroi.lua` | 共通ユーティリティ | GPL-3（Kagiroi本体） |
| `kagiroi_translator.lua` | librime translator窓口 | GPL-3（Kagiroi本体） |
| `kagiroi_viterbi.lua` | ラティス＋Viterbi変換本体 | GPL-3（Kagiroi本体） |
| `segmenter.lua` | 文節境界判定（Mozc segmenter.def 生成） | GPL-3（Kagiroi本体）。Mozc（BSD-3）由来データを含む生成物 |
| `kagiroi_kana_speller.lua` | 入力→かな processor | GPL-3（Kagiroi本体） |
| `lru.lua` | LRUキャッシュ（第三者取り込み） | MIT（ファイル冒頭ヘッダ） |
| `priority_queue.lua` | 二分ヒープ優先度付きキュー（第三者取り込み） | zlib（ファイル冒頭ヘッダ） |
| `dic/kagiroi_id.def` | 品詞ID定義 | GPL-3（Kagiroi本体） |
| `dic/matrix_custom.def` | 連接カスタム定義 | GPL-3（Kagiroi本体） |
| `dic/lex_excluded.csv` | 辞書除外語リスト | GPL-3（Kagiroi本体） |

Kagiroi本体のライセンス全文は、同梱の `LICENSE`（GNU General Public License v3.0、出所リポジトリと同一のものを一字不改変で配置）による。`lru.lua`・`priority_queue.lua` のライセンス文言は各ファイル冒頭のヘッダに原文のまま残っており、この取り込みではヘッダを含めて1バイトも変更していない。
