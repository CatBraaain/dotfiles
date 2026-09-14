# dsh session ID system prompt

全 agent session の system prompt に、現在の dsh session を識別する session ID を追加する plugin。

## Session ID の表示

| assembly の状態 | system prompt の結果 |
| --- | --- |
| agent があり、session ID が `session-a` | `Current dsh session ID: "session-a"` を含む |
| agent があり、session ID に引用符・改行・中括弧などがある | session ID を JSON 文字列として表示し、dsh の変数補間を発生させず prompt の構造を壊さない |
| agent がなく、診断用 assembly を行う | assembly は成功し、session ID の表示は空になる |

複数の agent session を assembly した場合、それぞれの system prompt は自身の session ID だけを含む。他の session の ID は含まない。

## 既存 section との共存

plugin は既存の system prompt section を保持し、session ID の表示を追加する。session ID section は agent-less assembly で空になるが、他の section の内容や順序を変更しない。

## 適用範囲

dispatcher が生成した session と DSH Web から手動作成した session の両方に適用する。UI、ticket の assignee 更新、ticket dispatcher の動作は提供しない。
