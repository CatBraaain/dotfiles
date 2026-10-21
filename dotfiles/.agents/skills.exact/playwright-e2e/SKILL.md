---
name: playwright-e2e
description: >-
  Playwright Test の E2Eテストの書き方の規範と、trace・HTML report による録画・レビュー運用の定め。
  E2Eテストの作成・修正、E2Eテストの録画・レビュー仕組みの検討時に使う。
---

# playwright-e2e

E2Eテストは、網羅性を確認するためのものと、人が操作を見て判断するためのものに
分ける。通常の E2Eテストだけで保守に必要な振る舞いをカバーし、review テストに
カバレッジを依存しない。review テストは人に見せるためだけのものであり、通常実行
と CI では実行しない。録画とレビューは Playwright内蔵の trace と report で行う。

## テストの書き方

- レビューの単位を `test.step()` にする。step名は操作文で、1 step を意図1つと
  確認1組に対応させる
- 主要な locator に `.describe("名前")` を付ける
- レビューのためのテストは `tests/review/` 配下に置く
- レビューのテストは人間らしく操作する。文字入力は
  `pressSequentially(text, { delay: 120 })`、クリックは `click({ steps: 15 })`
- アサーションは通常の `expect()` で書く

通常実行から `tests/review/` を除外する。config の `testIgnore` に
`"**/review/**"` を設定する。`testIgnore` は CLI でパスを指定しても適用される
ため、review を実行するときは `testIgnore` を解除した config を別に用意する。

```ts
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testIgnore: [],
});
```

review用のテストファイルで trace を有効にする。review の実行時に trace が
残るため、閲覧のためにテストを再実行する必要はない。全体の `--trace on` は使わず、
他のテストの trace設定は既存の方針を保つ。

```ts
import { test } from "@playwright/test";

test.use({ trace: "on" });
```

## レビューの見せ方

通常実行と review の部分実行は、同じHTML report に結果を保存する。既存の
Playwright config に `reporter: "html"` を設定する。他の reporter も使っている場合は、
既存の設定を維持し、reporter の配列へ `html` を追加する。

package.json に次の scripts を登録する。対象プロジェクトに E2E の script命名規約が
あれば、名前はそれに合わせる。

```json
{
  "scripts": {
    "test:review": "playwright test tests/review/ --config playwright.review.config.ts",
    "review": "playwright show-report --port 0"
  }
}
```

`test:review` は reviewテストを実行し、trace と report を残す手順である。
共通report は直近の実行結果で上書きされる。

`review` は標準の report を開く。`--port 0` により、9323 が使用中なら空きポートを
使う。既存設定で report の出力先を変更している場合は、`show-report` の引数にその
フォルダを渡す。Ctrl+C でサーバーを終了する。

エージェントが report をサーブするときは、`CLAUDECODE=1` を前置きして自動オープン
を抑止し、出力の URL をユーザーに伝える (例: `CLAUDECODE=1 bun run review`)。前置き
は Claude Code 限定ではなく、Playwright が coding agent 環境の検出に使う変数
(`CLAUDECODE` / `COPILOT_CLI`) の設定である。scripts には前置きを組み込まない。
ユーザーの手動実行ではブラウザーが開く方がよいためである。

手順:

1. `test:review` を実行し、review の録画を report に残す
2. `review` を `CLAUDECODE=1` 前置きで実行し、出力の URL をユーザーに伝える
