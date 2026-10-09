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
- レビューのためのテストは、タイトルに `@review` を埋め込んで網羅性のための
  テストと分ける
- `@review` のテストは人間らしく操作する。文字入力は
  `pressSequentially(text, { delay: 120 })`、クリックは `click({ steps: 15 })`
- アサーションは通常の `expect()` で書く

## レビューの見せ方

1. `trace: "on"` で実行する
2. `npx playwright show-report` を開く
3. 見る人には検索ワード付き URL を渡す: `http://localhost:9323/#?q=%40review`。
   開くと `@review` のテストだけが一覧に残る。動かないときは report の検索
   ボックスに `@review` と入力する
