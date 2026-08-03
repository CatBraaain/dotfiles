---
name: to-bdd-test-skeleton
description: >-
  合意した acceptance シナリオを、テストタイトルにシナリオを書き実装を空にしたBDD テストスケルトンに変換する — 実装も本番コードも書かない。
disable-model-invocation: true
---

# To BDD Test Skeleton

合意した **シナリオ** を BDD テストスケルトンに変換する。テストタイトル = 要件
（不変）、テスト実装 = 検証（可変）。タイトルまで作り、実装と本番コードは後続セッションで書く。

## 入力

会話で合意した内容から **シナリオのみ** を抽出し、実装の詳細（関数名/クラス名/モジュール構造、DBスキーマ/内部データ構造、APIエンドポイント/シグネチャ等）は切り捨てる。

抽出するのは「**ユーザーが観察する振る舞い**」= Given（前提）/ When（操作）/ Then（結果）のみ。シナリオが曖昧・欠落していれば、ユーザーへ追加質問する。

## 出力

1 Feature（シナリオ群）= 1ファイル。

**配置**: `tests/` 直下。種別分け（`e2e/`/`unit/`/`acceptance/`）のサブディレクトリは作らない。Feature/ドメイン単位のグルーピング用サブディレクトリは推奨。

**命名・拡張子**: `tests/` 配下の既存ファイル慣習を検出して従う。なければ FWデフォルト（vitest/bun-test: `*.test.ts`、pytest: `test_*.py`）。

## テストタイトルの書き方（要件定義書としての品質）

テストタイトルが要件の全て。以下を順守:

- **言語**: デフォルト英語。チャットで既に英語以外を使っている場合はユーザーに確認する。
- **構造**: 自然な文で Given-When-Then を表現。`Given:`/`When:`/`Then:` のマーカーは使わない。
  - 例: `persists a new user to the repository when registering with an unregistered email`
- **1テスト = 1振る舞い**: 1つの When-Then ペア。前提(Given)が複数でも1テストに畳む。
- **グループ = Feature**: 機能/ドメイン単位でグループ（describe/クラス）、その下にテストを並べる。

## 完成イメージ

vitest:

```ts
describe("User registration", () => {
  it("persists a new user to the repository when registering with an unregistered email", () => {});
  it("rejects with a duplicate error when registering with an already existing email", () => {});
});
```

pytest（クラス=Feature、メソッド=シナリオ、実装は `pass`）:

```python
class TestUserRegistration:
    def test_persists_new_user_to_repository_when_registering_with_unregistered_email(self):
        pass
```

## このスキルがやらないこと

- テスト実装（Given/When/Then のコード化、assertion）は書かない。
- 本番コード（src/ 等）は一切触らない。
- テストを実行して通すことはしない（全テストは赤で正常）。
- 要件文書・設計書・シナリオ一覧ドキュメントは作らない。
