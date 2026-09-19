# dsh web fixture スクショレビュー

fixture の合否は、各 plugin の SPEC.md と light/dark の個別スクリーンショットを照合して人が判定する。

## スクショ

| ファイル | 内容 |
|---|---|
| `dist/fixture.png` | light の全ケース一覧 |
| `dist/fixture-dark.png` | dark の全ケース一覧 |
| `dist/fixture-hover.png` | session-list の行を hover した一覧 |
| `dist/fixture-<case>.png` | 各ケースの light |
| `dist/fixture-<case>-dark.png` | 各ケースの dark |
| `dist/web-fixture.png` | fake RPC を使う実 dsh web の light 全体 |
| `dist/web-fixture-dark.png` | fake RPC を使う実 dsh web の dark 全体 |

## 判定基準

| case | 主な対応 SPEC | 確認ポイント |
|---|---|---|
| 1〜3. skill-status | `skill-status/SPEC.md` | skill 名の順序、空表示、長文の省略、gray 表示 |
| 4〜6. session-list | `session-list/SPEC.md` | workspace、status dot、時刻、blank、empty、hover actions |
| 7〜9. agents | `agents/SPEC.md` | auto/manual/idle の agent・class 表記、gray 表示 |
| 10. quota-line | `quota-line/SPEC.md` | provider quota の1行表示、secondary gray、カード上の位置。手書きの書式リファレンスであり、実 component の回帰検出には使えない |
| 11. concurrency-retry | `concurrency-retry/SPEC.md` | provider、待機秒、attempt の1行表示。実 bundle の chat-node 行を fake node で描画 |
| 12. custom-ui | `custom-ui/SPEC.md` | context meter と送信系ボタンが composer カード右下に並び、本文が下へ回り込まないこと。stock DOM を模した手書きレイアウトリファレンスであり、実画面は `web-fixture*.png` で確認する |
| light/dark | 各 plugin の SPEC.md | light/dark の双方で文字と背景のコントラストが崩れないこと |

`web-fixture*.png` では、titlebar（`document.title` の待機 mark と session タイトル）、
会話履歴、todo panel、skill-status、composer の実画面の組み合わせを確認する。撮影
スクリプトは transcript の描画と title を検証し、fixture 世界が route を持たない
quota-line・agents state の表示は写らない（静的 fixture のケースで確認する）。静的
fixture ではクリック、折りたたみ、popover、archive、workspace picker、clipboard、実際の
model 選択などを確認しない。
