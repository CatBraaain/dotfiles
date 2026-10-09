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

レビューの実行と閲覧は package.json の scripts 経由で行う。`@review` のテストや
レビューの仕組みを用意するとき、次の scripts を package.json に登録する。対象
プロジェクトに E2E の script 命名規約があれば、名前はそれに合わせる。

```json
{
  "scripts": {
    "review:test": "playwright test --grep @review --trace on",
    "review:open": "playwright show-report"
  }
}
```

trace は config に入れず `review:test` のフラグで on にする。網羅性のための
テストで trace が常時生成される副作用を避けるためである。網羅性のためのテストは
通常どおり実行する。

手順:

1. `review:test` を実行し、trace 付きの実行結果を作る
2. `review:open` で report を開く
3. 見る人には検索ワード付き URL を渡す: `http://localhost:9323/#?q=%40review`。
   開くと `@review` のテストだけが一覧に残る。動かないときは report の検索
   ボックスに `@review` と入力する
