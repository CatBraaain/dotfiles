# dsh web fixture スクショレビュー

fixture スクショを case 1〜9 の基準で合否判定するための契約。判定基準の正本は各 plugin の SPEC.md。判定は人が行う。

## スクショ

撮影は `bun run render.ts && bun run shot`（手順の詳細は README.md）。

| ファイル | 内容 | 主に確認する case |
|---|---|---|
| `dist/fixture.png` | light テーマ、全 case | 1〜9 |
| `dist/fixture-hover.png` | light テーマ、session-list の行を hover した状態 | 4（hover actions） |
| `dist/fixture-dark.png` | dark テーマ、全 case | 1〜9 |

## 判定基準

fixture は1画面に確認観点ごとのパターン（case 1〜9）を並べてある。各 case をラベル番号に沿って判定する。

| case | 対応する SPEC の振る舞い | 合否の確認ポイント |
|---|---|---|
| 1. skill-status — populated | `🎯 skills: ` に続けて skill 名を `, ` で連結、first-use 順、文字色 gray | 書式と順序。gray で読めること。行は入力欄カードの上に出る |
| 2. skill-status — empty snapshot | スキル未使用のときは `🎯 skills: ` のみを表示する | ラベルのみの行が gray で出る（名前は続かない） |
| 3. skill-status — many skills | 幅に収まらないときは `...` で行末省略 | 行末が `...` で切れ、画面外へあふれない |
| 4. session-list — workspace groups | ヘッダー（Workspaces ラベル + Add workspace アイコン）。登録済み workspace 単位のグループヘッダー行（フォルダーアイコン + タイトル、current グループは business 色フォルダー）。各行は status dot（running=青マトリクス / pending=橙 / done=緑 / idle=gray）+ タイトル + 相対時刻。current 行はハイライト。折りたたみ上限超過のグループは `Show n more sessions`。未所属セッションは Ungrouped バケット | dot の色分け、時刻の bucket（1min / 3h / 2d / 1mo）、グループごとの空気（4px）。hover actions のフラット配置は `dist/fixture-hover.png` で確認する。light / dark 両方で読めること |
| 5. session-list — blank current | 選択中の blank 行は所属グループの中で相対時刻なし・actions なしで表示される | 行の高さ・位置が通常行と揃い、右端に何も出ないこと |
| 6. session-list — empty | セッションが無いときは空の領域（ヘッダーは残る） | リスト領域が空で、エラーや余計な表示が出ないこと |
| 7. agents — auto class | agent 行 `🤖 agent: <name>` と class 行 `💎 class: <name> (auto: <model>)` の2行ボタン（メニュー閉状態）。文字色 gray | 2行の書式（コロンの後ろはスペース1つ、model は `auto: ` に続く）、gray で読めること。行は入力欄カードの上。2行は縦に積まれ、行間は dock の行間と同じリズムであること。中央バンド（case 1〜3 の `🎯 skills:` 行と同じ幅・中央寄せ）に左揃えで置かれること |
| 8. agents — manual class | 手動選択中は `(manual: <model>)` | `manual: ` 表記と model 名。agent 行も切替後の名前になること |
| 9. agents — idle session | 見込み model を解決できないときは `(auto)` のみ | model 名が付かずモードだけの表記。初期 agent/class が表示されること |
| light / dark 両方 | gray は light / dark で別の token 値 | どちらのテーマでも読めること（黒や白に潰れない） |

## 範囲

- titlebar は React 無関係（`document.title` への書き込み）のため fixture では検証できず、実 dsh web 起動後の確認対象
- クリック・折りたたみ・メニュー開状態など fixture で確認できない振る舞いは、実 dsh web 起動後の確認対象。その一覧は README.md の「制限」に定める
