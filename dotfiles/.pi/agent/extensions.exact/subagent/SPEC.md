# Subagent Extension — ミニマル化仕様

本ファイルは `index.ts` を「子エージェントを安全に呼び出すための最小限のツール」へ
縮小するための仕様。新機能の追加ではなく減らす方向。実装者は本ファイルを元に
`index.ts` / `index.test.ts` / `README.md` を書き直す。

## 設計方針（合意事項）

- **最小限の機能**におさめる。ペルソナ機能・役割付け系は廃止。
- 子エージェントの**思考出力はユーザーに表示**し、親エージェントには**最終出力のみ**渡す。
  （現状の `onUpdate`=ユーザー向けストリーミング / `content`=親向け最終テキスト の分離で成立。維持）
- 親がキャンセルされたら**子にキャンセル伝播**。

## ツール interface

**single モードのみ。** parallel / chain は廃止。

| パラメータ | 型 | CLI フラグ | 備考 |
|---|---|---|---|
| `task` | string（必須） | — | 子に渡すタスク |
| `model` | string? | `--model` | モデルオーバーライド |
| `cwd` | string? | — | 省略時は親の `ctx.cwd` |

## 子プロセス起動

```
pi --mode json -p --no-session [--model X]
```

最終引数として `Task: <task>` を渡す（現状どおり）。

- 子は**スキル自動発見あり**（親と同じルール）。
- `--no-skills` / `--skill` / `--append-system-prompt` は渡さない。
- 一時ファイル経由の systemPrompt 処理（`writePromptToTempFile`）は廃止。

## 表示

- **collapsed / expanded（Ctrl+O）の 2 モードを維持。**
- **usage 表示は廃止** → `formatUsageStats` / `formatTokens` / usage tracking ごと削除。
- **ツールコールは汎用 1 行表示**（`→ toolName {args preview}`）。
  - `formatToolCall` の個別ケース（`bash` / `read` / `write` / `edit` / `ls` / `find` / `grep`）は全削除。
  - 汎用フォールバックのみ残す。
- **ラベル**は `deriveLabel` を `config.model ?? "task"` の 1 行に簡略化（`step` 引数は廃止）。
- ストリーミング（`onUpdate` で思考テキスト + ツールコールをリアルタイム表示）は維持。

## 安全・停止

- **abort 伝播**: SIGTERM → 5 秒 → SIGKILL（現状維持）。
- **タイムアウト**: なし（親が Ctrl+C したときのみ停止）。

## テスト

- `deriveLabel` のテストを **`model` / `task` の 2 ケース**に縮小。
  - `skills` / `step` 関連のケースは削除。
- 実行: `bun --install=auto run index.test.ts`

## README

- ミニマル版に全面書き換え。
- 削除: parallel / chain / shaping（systemPrompt / skills / noSkills）/ usage 系 / ツール別フォーマットの記述。

---

## 実装時の削除チェックリスト

### モード・型
- [ ] parallel / chain の実行・表示ロジック
- [ ] `mapWithConcurrencyLimit`
- [ ] `truncateParallelOutput`
- [ ] 定数 `PER_TASK_OUTPUT_CAP` / `MAX_PARALLEL_TASKS` / `MAX_CONCURRENCY`
- [ ] `SubagentParams` の `tasks` / `chain`
- [ ] `TaskItem` / `ChainItem`（Typebox スキーマ）
- [ ] `SingleResult.step`
- [ ] `SubagentDetails.mode`（single 固定になるため削除可）
- [ ] `renderResult` の 3 モード分岐 → single ブロックのみ残す
- [ ] `execute` 内の `modeCount` / `makeDetails` / chain・tasks・invalid の各分岐 → single のみ

### 役割付け系（systemPrompt / skills / noSkills）
- [ ] `TaskConfig`: `systemPrompt` / `skills` / `noSkills` / `tools` を削除（`model` / `cwd` のみ残す）
- [ ] `SubagentParams`: `systemPrompt` / `skills` / `noSkills` / `tools` を削除
- [ ] `runSingleAgent`: `--append-system-prompt` / `--skill` / `--no-skills` / `--tools` の args 構築を削除
- [ ] `writePromptToTempFile` 関数を削除
- [ ] `runSingleAgent` 内の `tmpPromptDir` / `tmpPromptPath` / `finally` クリーンアップを削除

### usage 系
- [ ] `UsageStats` interface
- [ ] `SingleResult.usage`
- [ ] `currentResult.usage` の累積ロジック（`message_end` 内の input/output/cacheRead/cacheWrite/cost/contextTokens/turns）
- [ ] `formatUsageStats` / `formatTokens`
- [ ] `aggregateUsage`
- [ ] 表示箇所の `usageStr` 行（collapsed / expanded 両方）

### ツールコール表示
- [ ] `formatToolCall` の `switch` 個別ケース（`bash` / `read` / `write` / `edit` / `ls` / `find` / `grep` / `default`）
  - `default` の汎用フォールバックのみ残し、関数は実質 1 形式に縮小（あるいはインライン化）

### deriveLabel
- [ ] `skills` / `step` の分岐を削除
- [ ] `config.model ?? "task"` の 1 行にし、第 2 引数 `step` を削除

### renderCall（ツール呼び出し時のプレビュー）
- [ ] `optsTag` から `skills` / `noSkills` / `systemPrompt` の表示を削除（`model` のみ残す）
- [ ] chain / tasks の分岐を削除し single のみ

## 残すもの（現状維持）

- single モードの実行・ストリーミング・abort 伝播の骨格
- `getFinalOutput` / `getResultOutput` / `isFailedResult`
- `getPiInvocation`（pi 起動解決）
- `stderr` 蓄積とエラー表示
- `stopReason` / `errorMessage` の伝播と表示
- expanded の Markdown 最終出力レンダリング
