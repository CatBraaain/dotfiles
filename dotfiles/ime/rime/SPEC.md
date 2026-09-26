# Kagiroi 日本語入力

対象は、Windows の Weasel と Linux の fcitx5-rime から共通の Kagiroi 日本語変換を使う Rime ユーザー設定である。設定ファイルは dotfiles で管理し、Windows と Linux の各 Rime ユーザーデータディレクトリへ配置する。Kagiroi のスキーマ、辞書、Lua プラグインが利用可能な環境を前提とする。

## 入力と変換

Rime の選択スキーマは Kagiroi とする。入力中の連続する `n` は次のキーまで保留し、次のキーに応じて処理する。

- 母音が続く場合、`n` が1個なら次の音節へ結合する。2個以上なら余剰分を畳み、先頭の `n` を「ん」、最後の `n` を次の音節の頭として扱う。
- 子音またはスペースが続く場合、`n` の連続を1つの「ん」にし、後続キーはその後に処理する。`y` はローマ字の拗音を保つため音節の継続として扱う。
- 入力カーソルが編集中の末尾にない場合、この補正は行わずKagiroi標準処理に委ねる。

| 入力 | 編集中の読み | 変換候補に含まれる文字列 |
|---|---|---|
| `kanji`、`kannji`、`kannnji` | `かんじ` | `かんじ`、`漢字`、`感じ` のいずれか |
| `kana` | `かな` | `かな` |
| `kanna`、`kannna`、`kannnna` | `かんな` | `かんな` |
| `konitiha` | `こにちは` | — |
| `konnnitiha` | `こんにちは` | `こんにちは` |
| `kanda`、`kannnda` | `かんだ` | — |
| `nya` | `にゃ` | — |

編集中の読みは、漢字変換が確定する前のローマ字入力の結果として表示されるかなである。候補列が `—` の入力は読みと一致する辞書語を期待せず、読みが期待どおりになることを確認する。

## Windows / Linux 共通の操作と候補表示

Windows の Weasel と Linux の fcitx5-rime で Kagiroi を使用するとき、`Zenkaku_Hankaku` は Rime の日本語入力と英字入力を切り替える。入力中の `Henkan` は編集中の文字列の第一候補をカタカナにし、そのキーでは確定しない。

日本語入力中は、入力開始から候補一覧を表示しない。候補のある入力で最初に `Space` を押すと、入力を確定せず候補一覧を表示し、第一候補を選択する。候補一覧を表示した後の `Space` は、入力を確定せずに選択を次の候補へ移す。最後の候補の次は第一候補に戻る。`Enter` は選択中の候補を確定する。次の入力では再び `Space` を押すまで候補一覧を表示しない。

Windows の Weasel では、入力状態の通知とトレイアイコンを表示しない。

## 配置

同じ Rime 設定を次のユーザーデータディレクトリへ配置する。

- Windows / Weasel: `%APPDATA%/Rime`
- Linux / fcitx5-rime: `~/.local/share/fcitx5/rime`

dotfiles は共通の `default.custom.yaml`、`kagiroi.custom.yaml`、n 入力の補正と共通キー・候補操作の Lua、Weasel 固有の `weasel.custom.yaml` を管理する。Weasel の表示設定は Linux の fcitx5-rime の表示に影響しない。Kagiroi の標準ローマ字 processor とスキーマ構成を保ち、Rime が生成するデータベース、ユーザー辞書、学習データは既存内容を保持する。
