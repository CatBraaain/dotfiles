# stream-idle-timeout

LLMストリームの沈黙(最終delta から 5分)を検知して、現在の agentターンを abortする拡張。

## 背景

- pi の `httpIdleTimeoutMs` は OpenAI SDK の `timeout` に渡るのみで、セマンティクスは「リクエスト開始 → レスポンスヘッダー受信まで」。SSE 200受信以降に chunk が流れない沈黙には効かない
- 2026-09-10、junior subagent 2件が LLM応答待ちのまま無限沈黙し、親セッションごとスタックした
- タイマー値は 300,000ms(5分)の固定定数。settings / 設定ファイルによる拡張はしない(YAGNI)

## 挙動

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| プロバイダへのリクエスト開始(`before_provider_request`) | 5分タイマーを起動 | 最初の delta前(ヘッダー受信後の沈黙)も対象 |
| ストリームdelta(`message_update`) | タイマーをリセット | 最終ストリーム活動から数え直す |
| メッセージ確定(`message_end`) | タイマーを停止 | ツール実行・待機中はカウントしない |
| タイマー発火(5分間の沈黙) | `ctx.abort()` | 現在の agentターンを中断する |

実装上の判断:

- タイマー起点は拡張イベント `before_provider_request`(pi 0.84.4 の docs/extensions.md と `ExtensionAPI` 型で実在を確認済み)。リクエスト開始から起動するため「最初の delta前のヘッダー保留」も対象になる。このイベントが存在しない場合は `message_start` 起点とし、最初の delta前のヘッダー保留は coverage外となる
- `message_update` は assistant のストリーミングdelta でのみ発火するため、role判定なしでリセットする
- `message_end` は user / assistant / toolResultすべてで発火するが、プロバイダリクエストの in-flight中に発火するのは当該assistantメッセージのみ(agent-loop のイベント順で確認済み)。user・toolResult の `message_end` はリクエスト間でのみ発火するため、role判定なしで停止してよい
- サブエージェントの子pi にも本拡張は読み込まれるため、子セッションでも同様に効く(追加実装・設定は不要)

## coverage外(既知の限界)

- abort はターン単位。`message_end` 後の拡張側待機(concurrency-retry のバックオフ待ち)中はカウントしない
- delta が細かく流れ続ける長時間生成は切らない(目的が沈黙検知のため)
- プロバイダコールが `message_end` なしで例外終了した場合、タイマーは armed のまま残るが、次のリクエストで再起動され、idle中の `ctx.abort()` は無害

## テスト方法

```sh
cd dotfiles/.pi/agent && bun test   # index.test.ts はタイマーをシーム注入で差し替え、実時間を待たない
cd dotfiles/.pi/agent && bunx tsc --noEmit
```
