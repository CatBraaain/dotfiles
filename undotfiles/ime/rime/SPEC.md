# Kagiroi 日本語入力

対象は、Windows の Weasel と Linux の fcitx5-rime から共通の Kagiroi 日本語変換を使う Rime ユーザー設定である。設定ファイルは dotfiles で管理し、Windows と Linux の各 Rime ユーザーデータディレクトリへ配置する。Kagiroi のスキーマ、辞書、Lua プラグインが利用可能な環境を前提とする。

## 入力と変換

Rime の選択スキーマは Kagiroi とする。入力中の連続する `n` は次のキーまで保留し、次のキーに応じて処理する。

- 母音が続く場合、`n` が1個なら次の音節へ結合する。2個以上なら余剰分を畳み、先頭の `n` を「ん」、最後の `n` を次の音節の頭として扱う。
- 子音またはスペースが続く場合、`n` の連続を1つの「ん」にし、後続キーはその後に処理する。`y` はローマ字の拗音を保つため音節の継続として扱う。
- 入力カーソルが編集中の末尾にない場合、この補正は行わずKagiroi標準処理に委ねる。

| 入力 | 変換候補に含まれる文字列 |
|---|---|
| `kanji`、`kannji`、`kannnji` | `かんじ`、`漢字`、`感じ` のいずれか |
| `konnichiha`、`konnnichiha` | `こんにちは` |
| `kana` | `かな` |
| `kanna` | `かんな` |

`kana` の第一候補は `かな`、`kanna` の第一候補は `かんな` とする。`konichiha` はこの規則では `こんにちは` の受入例に含めない。

## 配置

同じ Rime 設定を次のユーザーデータディレクトリへ配置する。

- Windows / Weasel: `%APPDATA%/Rime`
- Linux / fcitx5-rime: `~/.local/share/fcitx5/rime`

dotfiles は `default.custom.yaml`、`kagiroi.custom.yaml`、n 入力を保留する Lua processor を管理する。Kagiroi の標準ローマ字 processor とスキーマ構成を保ち、Rime が生成するデータベース、ユーザー辞書、学習データは既存内容を保持する。
