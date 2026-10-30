---
name: playwright-e2e
description: >-
  Playwright Test の E2Eテストの書き方と、HTML report の閲覧に関する規範。
  E2Eテストの作成・修正や、HTML report の閲覧時に使う。
---

# playwright-e2e

E2Eテストで、保守に必要な振る舞いをカバーする。

## テストの書き方

- 操作と確認の単位を `test.step()` にする。step名は操作文で、1 step を意図1つと
  確認1組に対応させる
- 主要な locator に `.describe("名前")` を付ける
- アサーションは通常の `expect()` で書く

## HTML report の閲覧

既存の HTML report を `show-report` でサーブする場合、エージェントは
`CLAUDECODE=1` を前置きして自動オープンを抑止し、出力の URL をユーザーに伝える
(例: `CLAUDECODE=1 playwright show-report --port 0`)。

`--port 0` により、9323 が使用中なら空きポートを使う。既存設定で report の出力先を
変更している場合は、`show-report` の引数にそのフォルダを渡す。Ctrl+C でサーバーを
終了する。

前置きは Claude Code 限定ではなく、Playwright が coding agent 環境の検出に使う変数
(`CLAUDECODE` / `COPILOT_CLI`) の設定である。既存の script経由で実行する場合も、
前置きはエージェントの呼び出し時に付け、scripts には組み込まない。ユーザーの
手動実行ではブラウザーが開く方がよいためである。
