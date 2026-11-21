---
name: writing
description: >-
  自然言語のテキストファイル（markdown・AI への指示テキスト等）の編集時に読み込む。対象に応じて references/ の技法カタログを読み、適用する。
---

# Writing

自然言語のテキストファイルの作成・編集・レビューの際に、対象を判定し、対応する技法カタログを read して適用する。プログラミングコード・設定ファイルは coding skill の対象。

## 振り分け

| 編集対象 | カタログ |
| --- | --- |
| markdown 文書 | `references/readable-docs.md` |
| AI への指示テキスト（SKILL.md・AGENTS.md・SPEC.md・REQUIREMENTS.md・システムプロンプト・プロンプトテンプレート等） | `references/readable-docs.md` ＋ `references/effective-prompt.md` |

複数にまたがるときは該当するカタログをすべて読む。可読性の相談は `references/readable-docs.md` を読んで答える。指示テキストの内容・適用境界の相談は `references/effective-prompt.md` を読んで答える。成果物の報告文を整えるときも `references/readable-docs.md` を使う。

`/tmp` 等の使い捨て検証スクリプトと、文書を変更・評価しない調査には使わない。

## 手順

1. 編集対象を判定し、対応するカタログを read する
2. カタログ本文の指示に従い、全項目と照合して適用する
