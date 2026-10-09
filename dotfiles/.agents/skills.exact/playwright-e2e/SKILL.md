---
name: playwright-e2e
description: Playwright Test で E2E テストを作成・修正するとき、録画やレビューの仕組みを検討するときに使う。
---

# playwright-e2e

E2E テストは、網羅性を確認するためのものと、人が操作を見て判断するためのものに
分ける。録画とレビューは Playwright 内蔵の trace と report で行う。

## テストの書き方

- レビューの単位を `test.step()` にする。step 名は操作文で、1 step を意図 1つと
  確認 1組に対応させる
- 主要な locator に `.describe("名前")` を付ける
- レビューのためのテストは `tests/review/` 配下に置く
- レビューのテストは人間らしく操作する。文字入力は
  `pressSequentially(text, { delay: 120 })`、クリックは `click({ steps: 15 })`
- アサーションは通常の `expect()` で書く

通常の E2E 実行には review のテストも含める。アサーションで回帰を検知するため、
網羅性のためのテストとシナリオが重複していても実行する。

review 用のテストファイルで trace を有効にする。通常実行でも review の trace が
残るため、閲覧のためにテストを再実行する必要がない。全体の `--trace on` は使わず、
他のテストの trace 設定は既存の方針を保つ。

```ts
import { test } from "@playwright/test";

test.use({ trace: "on" });
```

## レビューの見せ方

通常実行と review の部分実行は、同じ HTML report に結果を保存する。既存の
Playwright config に `reporter: "html"` を設定する。他の reporter も使っている場合は、
既存の設定を維持し、reporter の配列へ `html` を追加する。

package.json に次の scripts を登録する。対象プロジェクトに E2E の script 命名規約が
あれば、名前はそれに合わせる。

```json
{
  "scripts": {
    "test:review": "playwright test tests/review/",
    "review": "playwright show-report --port 0"
  }
}
```

`test:review` は review テストだけ確認したいときの部分実行であり、閲覧の必須手順
ではない。共通 report は直近の実行結果で上書きされる。

`review` は標準の report を開く。`--port 0` により、9323 が使用中なら空きポートを
使う。既存設定で report の出力先を変更している場合は、`show-report` の引数にその
フォルダを渡す。Ctrl+C でサーバーを終了する。

手順:

1. 通常の E2E テストを実行する。部分確認だけなら `test:review` を使う
2. `review` で report を開き、`tests/review/` のテストを閲覧する
