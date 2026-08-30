---
name: any-standard
description: >-
  汎用3スキル（any-implement / any-review / any-workflow）と standard スキルからなる規則スキル構成の規則。standard スキルの新規作成・改修・調整、汎用3スキル自体の改修、規則スキル構成のレビューで使う。「standard スキルを書いて」「新しい規則スキルを追加して」「any スキルを直して」「規則スキル構成をレビューして」等の依頼で発火。AI に与える指示テキスト一般の品質は instruction-standard が、各ドメインの規則は各 standard が所有し、この標準は規則スキル構成のみを所有する。
---

# Any Standard

汎用3スキルと standard スキルからなる規則スキル構成（命名・配置・役割分担・正本所在）の規則を所有する。手続きの骨格は汎用3スキル、指示テキスト一般の品質は instruction-standard が担う。

| 作業 | 手続き | 適用する規則 |
| --- | --- | --- |
| standard・汎用スキルの作成・改修 | any-implement | この SKILL.md + `references/implement.md` |
| 規則スキル構成のレビュー | any-review | この SKILL.md + `references/review.md` |

## 適用条件

- 適用する: standard スキル（`xxx-standard`）の新規作成・改修・調整。汎用3スキル自体の作成・改修。新しいスキルを standard スキルとして作るかの判断。規則スキル構成のレビュー。
- 適用しない: AI に与える指示テキスト一般の品質（契約の書き方・Decision Ladder 記法・種別規範）は instruction-standard、各 standard が所有するドメインの規則内容（spec の書き方・可読性の基準等）は該当する standard、個別の実装・レビュー作業の手続きは汎用3スキル + 該当する standard がそれぞれ担う。

## 規則スキル構成

```text
汎用スキル（3つ固定）
  any-implement    # 規則に従って成果物を作る
  any-review       # 成果物を oracle に照合して指摘のみ出す
  any-workflow     # 要件合意 → 作成 → レビュー → 収束を管理する

standard スキル（ドメインごと）
  xxx-standard/SKILL.md                  # 規則本体（oracle）
  xxx-standard/references/implement.md   # 固有の作成手続き（必要なときだけ）
  xxx-standard/references/review.md      # 固有の照合軸・種別・指摘形式（必要なときだけ）
  xxx-standard/references/workflow.md    # 固有のフェーズ・収束ルール（必要なときだけ）
```

ドメインが増えても汎用スキルは3つのまま増やさず、standard を追加するだけで新しい収束ワークフローに対応する（3×N → 3+N）。4つ目の汎用スキルを作らない。

## 命名と種別

- 新規の standard は `xxx-standard` と命名する。
- 改名しない既存の規則スキル（research-strategy 等）も、そのまま組み合わせに使える。
- standard スキルにするかは「ドメインの規則（oracle）を所有し、汎用3スキルの骨格と組み合わせて使うか」で判断する。規則を持たず単発の調査・対話で完結するスキルは standard スキルにせず、単発スキルとする。

## 構成契約

- SKILL.md は規則本体（適用条件・記法・Verify）を持ち、oracle となる。
- SKILL.md の規則本体に書く指示は、そのドメインに固有のものだけに限る。汎用3スキルが所有する手続き・規則を再掲しない。複数の standard でそのまま使える汎用的な指示を本体に置かず、汎用3スキルへの移動候補とする。
- `references/` は、汎用のデフォルトプロトコルで足りない固有手続きがあるときだけ置く。置かない standard は汎用のデフォルトで動く。
- 置いた `references/` は、SKILL.md の作業対応表からどの作業に適用されるか読み取れるようにする。
- 複数の standard で使う一般規則は、1つの standard が正本として所有し、他は参照する。コピーしない。
- 汎用3スキルは兄弟関係であり、規則を参照で共有しない。共通の手続きは各自の本文に重複して持つ（DRY より自己完結を優先する）。any-workflow がフェーズの委譲先として any-implement / any-review を指定するのはこの限りではない。

## 役割分担と正本所在

| 関心事 | 所有者 |
| --- | --- |
| ドメインの規則（適用条件・記法・Verify） | standard の SKILL.md |
| 手続きの骨格（規則の組み立てから検証・出力まで） | 汎用3スキル |
| 固有の照合軸・抽出方法・収束ルール | standard の `references/` |

規則・軸を汎用スキルへコピーしない。規則の正本は常に standard 側に置く。汎用3スキルは手続きの骨格のみを所有し、ドメイン規則を持たない。

## 他の規則ソースとの関係

- AGENTS.md は汎用3スキルの作業時以外でも常に適用される入口ファイルであり、本構造の置き換え対象ではない。汎用3スキルの作業時には AGENTS.md も規則ソースの1つとして組み合わせに加わる。
- standard スキルの作成時は、規則スキル構成をこの標準が、本文の品質を instruction-standard が、それぞれ所有する。

## Verify

standard・汎用スキルを作成・改修したとき、次を満たす。判定文言の正本は参照先セクションとし、ここでは再掲しない。

- [ ] 命名が `xxx-standard` に従い、既存規則スキルの改名を強制していない（§命名と種別）
- [ ] 種別判断が「規則（oracle）の所有」に基づき、単発スキルを standard スキルとして作っていない（§命名と種別）
- [ ] SKILL.md が規則本体を持ち、規則・軸が汎用スキルへコピーされていない（§役割分担と正本所在）
- [ ] `references/` に汎用デフォルトで足りる内容が置かれていない（§構成契約）
- [ ] SKILL.md の規則本体がドメイン固有の指示のみを含み、汎用3スキルとの重複や複数 standard で使える汎用指示が混入していない（§構成契約）
- [ ] 汎用3スキルにドメイン規則が混入しておらず、4つ目の汎用スキルを作っていない（§規則スキル構成、§役割分担と正本所在）
- [ ] 新規 standard が既存 standard とドメインを重複所有していない（§役割分担と正本所在）
