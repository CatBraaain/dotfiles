# notify 拡張機能 Spec

エージェントの処理が終わって入力を待つ状態になったとき、ターミナルのネイティブ通知を1回送る。

## トリガー

| イベント | 動作 |
| --- | --- |
| `agent_end` | 通知を送る |

## 通知内容

| 項目 | 値 |
| --- | --- |
| タイトル | `Pi` |
| 本文 | `Ready for input` |

## プロトコルの選択

実行環境の環境変数に応じて、通知を送るプロトコルを1つ選ぶ。判定は上から順に最初に一致したもの。

| 条件 | プロトコル | 対応ターミナル |
| --- | --- | --- |
| `WT_SESSION` が設定されている | Windows トースト通知 | Windows Terminal（WSL） |
| `KITTY_WINDOW_ID` が設定されている、または `TERM_PROGRAM` が `vscode` | OSC 99 | Kitty, VSCode |
| 上記以外 | OSC 777 | Ghostty, iTerm2, WezTerm, rxvt-unicode |

### Windows トースト通知

`powershell.exe -NoProfile -Command` を実行し、Windows の ToastNotification API でトーストを表示する。トーストの本文には `<本文>` のみが表示され、`<タイトル>` は表示されない。タイトルは Windows の通知元識別（AppId）文字列として使用される。

### OSC 99（Kitty / VSCode）

標準出力へ次の2つのエスケープシーケンスを順に書き出す。

1. `ESC ] 99 ; i=1:d=0; <タイトル> ESC \`
2. `ESC ] 99 ; i=1:p=body; <本文> ESC \`

### OSC 777

標準出力へ次のエスケープシーケンスを書き出す。

```
ESC ] 777 ; notify ; <タイトル> ; <本文> BEL
```

## スコープ外（やらないこと）

- 通知の成否を検証しない。
- 通知の重複制御（すでに待機中の場合は送らない、等）はしない。`agent_end` のたびに送る。
