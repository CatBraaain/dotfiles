---
name: writing
description: >-
  edit・write ツールや bash によるファイル・文書の作成・編集・レビューの際に必ず読む入口スキル。対象に応じて references/ 配下の技法カタログ（コードの読みやすさ・実装手段の選択・文書の可読性・指示テキストの品質基準）を読み、適用する。可読性や指示テキストの内容・適用境界の相談にも使う。読み取りだけの調査には使わない。
---

# Writing

ファイル・文書の作成・編集・レビューの際に、対象を判定し、対応する技法カタログを read して適用する。

## 振り分け

| 編集対象 | カタログ |
| --- | --- |
| ソースコード・テスト・ビルド/検証コード・CSS・設定ファイル（YAML・TOML・JSON 等） | `references/readable-coding.md` ＋ `references/maintainable-coding.md` |
| markdown 文書 | `references/readable-docs.md` |
| AI への指示テキスト（SKILL.md・AGENTS.md・SPEC.md・REQUIREMENTS.md・システムプロンプト・プロンプトテンプレート等） | `references/readable-docs.md` ＋ `references/effective-prompt.md` |

複数にまたがるときは該当するカタログをすべて読む。可読性の相談は `references/readable-docs.md` を読んで答える。指示テキストの内容・適用境界の相談は `references/effective-prompt.md` を読んで答える。成果物の報告文や、コード内の説明文を整えるときも `references/readable-docs.md` を使う。

`/tmp` 等の使い捨て検証スクリプトと、コード・文書・設定を変更・評価しない調査には使わない。

## 手順

1. 編集対象を判定し、対応するカタログを read する
2. カタログ本文の指示に従い、全項目と照合して適用する
