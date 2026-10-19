---
name: specs
description: >-
  SPEC.md・REQUIREMENTS.md・specs/<feature-name>.spec.md等の spec・requirements文書の要否・配置・作成・修正の規則。CSDDの正本のうちspec・requirements形式を所有し、skill `csdd` から参照される。spec・requirementsファイルを作成・修正するとき、またはその要否・配置を判断するときに適用する。既存の spec を読んで照合・レビューするだけのときは発火せず、CSDD適合性レビュー・乖離検知・照合は `csdd` が所有する。
---

# Specs

## 責務境界

- 本skillはspec・requirements形式（`SPEC.md`・`REQUIREMENTS.md`・`specs/<feature-name>.spec.md`等）の要否、配置、作成、修正を所有する。
- CSDDの適用条件、正本の確定、CSDD適合性レビュー、乖離検知、収束時の引継ぎは`../csdd/SKILL.md`が所有する。4軸の照合規則を複製しない。
- 文書の自己完結は`../readable-docs/SKILL.md`の「文書の自己完結」、一般的な重複排除は同Skillの「重複の排除」、記法の選択は同Skillの「記法の選択」を正本とする。

## 正本の階層

- 正本はrequirements → spec → 実装の順に下流へ制約を渡す。
- 照合の方向と過剰実装の確認は、`../csdd/SKILL.md`のcoverageと余剰の軸に従う。
- 上流が存在しない対象では、その上流との照合と整備をしない。
- specのみの対象（`REQUIREMENTS.md`がない対象）は、`SPEC.md`を最上位の正本として扱い、requirements準拠の確認とcoverage第1段をしない。
- requirementsのみの対象（`SPEC.md`がない対象）は、観測可能な振る舞いと受け入れ条件をrequirementsに含め、`REQUIREMENTS.md`を最上位かつ唯一の正本として扱い、specの作成・セルフチェックとcoverage第1段をしない。
- 正本なしの対象は、「要否」の確認でspec・requirementsを作らず、合意した振る舞いで進む対象である。実装前に振る舞いの合意を取り、照合時には適用外の対象と合意内容を報告する。デザイン正本に関する規則は引き続き適用する。
- 合意で進む対象では、spec・requirementsの整備・承認、CSDD適合性レビュー・乖離検知、oracle不在時の停止・正本への対応付け必須をしない。
- coverage第1段など、照合手順の詳細は`../csdd/SKILL.md`が所有する。

## 要否

- 新規・既存の分岐は、ファイル単位ではなく観測可能な機能・公開関数単位で判定する。既存ファイルへの新しい機能・公開関数の追加は新規追加、既存機能・公開関数の変更は既存の編集として扱う。観測対象の変更を伴わない内部helperの追加は、specの要否判断をしない。
- 新規追加では、specを作成するかユーザーに確認する。対象の既存specがあれば、新規作成ではなく更新として扱う。
- 既存の編集では、既存specに記載された振る舞いを変更する場合はそのspecを更新する。specがなければ自動作成せず、「プロジェクト判定」に従って提案の有無を決める。提案するときは理由を添えてプロジェクトへの作成を提案し、承認を得る。作成が不要なら、合意した振る舞いで進め、specなし自体への独立した承認を求めない。
- specを新規作成する局面では、requirementsも一緒に作るのがデフォルトである。ごく小規模な対象では、SPECを作らずrequirementsのみとする選択肢を要否確認に含めてよい。

## プロジェクト判定

spec・requirements を新規作成する提案の有無を、リポジトリが自分のプロジェクトかで判定する。

1. remote origin があるリポジトリでは、`gh repo view --json isFork,viewerPermission` で判定する。
   - `isFork` が `true`、または `viewerPermission` が `READ` 以下 → 外部リポジトリ。新規作成を提案しない
   - `viewerPermission` が `WRITE`・`MAINTAIN`・`ADMIN` → 自分のプロジェクト。新規作成を提案できる
2. `gh repo view` が失敗したら（remote なし・非GitHub・未認証など）、先頭コミットの author email と `git config user.email` を比較する。一致すれば自分のプロジェクト、不一致なら外部リポジトリとして扱う
3. いずれでも判定できない場合（git でない、`user.email` 未設定など）は、必要と判断した場合に理由を添えてプロジェクトへの作成を提案する質問にフォールバックする

- 外部リポジトリと判定した対象に spec・requirements を作成するのは、ユーザーの明示依頼があるときだけである。
- 判定が決めるのは新規作成の提案の有無だけである。既存の正本の照合・更新には影響しない。

## 配置

- 配置が明示済みならそれに従う。未指定なら、プロジェクトへの配置をユーザーに確認し、回答を待つ。要否と配置の質問は、共有`~/.agents/AGENTS.md`の「Asking Format」に従って可能な限り1回にまとめる。明示済みの指示・承認は再確認しない。
- 単一機能はプロジェクト直下の`REQUIREMENTS.md`・`SPEC.md`、複数機能は`specs/<feature-name>.requirements.md`・`specs/<feature-name>.spec.md`に置く。`specs/<feature-name>/REQUIREMENTS.md`も許容するが、明示的な指定がない限りフラット配置を優先する。プロジェクト内で両形式を混在させず、既存配置（`spec/<feature-name>.md`等）があれば維持する。機能は実装モジュールではなくユーザーが認識する単位で分ける。
- 共有リポジトリ（OSS上流など）へは、その規約に合わないファイルを残さない。プロジェクトに置けない場合は、その制約を示して配置またはspecなしで進めるかを確認する。

## requirementsの作成

- requirements単独の作成・変更は、ユーザーの明示依頼か、課題・目的・制約の合意が必要になったときに行う。
- requirementsの変更には人間の承認が必要である。人間の回答によって確定した詳細仕様はspecへ反映し、specの再レビューは求めない。
- 記載例の冒頭・役割・運用原則は、対象ごとに固有の内容へ置き換える:

````markdown
# REQUIREMENTS.md

## 目的

実現したいこと・解決したい課題を定義する、CSDDの上位文書。

## 役割

- **REQUIREMENTS.md（第一級レビュー対象）**：課題・目的・期待する成果・重要な制約を記述する。人間がレビュー・承認する。
- **SPEC.md（第二級レビュー対象）**：Requirementsを実現するための具体的な仕様を記述する。原則エージェントがレビューし、判断が必要な場合のみ人間に質問する。

## 運用原則

- requirementsとspecは、現在有効な正本として扱う。
- RequirementsはSpecの要約ではなく、Specの根拠となる。
- 人間の回答によって確定した詳細仕様はspecに反映し、再レビューは不要。
- SpecはRequirementsに準拠し、矛盾してはならない。
- Requirementsの変更には人間の承認が必要。

## ディレクトリ構成

単一機能はプロジェクト直下、複数機能は`specs/`配下にフラットに置く。

```text
REQUIREMENTS.md
SPEC.md
specs/
  <feature-name>.requirements.md
  <feature-name>.spec.md
```
````

## specの作成・修正

- specは合意済みの完成状態を記述し、1ファイルで自己完結させる。specはrequirementsに準拠し、requirementsと矛盾してはならない。requirementsと矛盾する変更要求が合意された場合は、requirementsの変更としてユーザーの承認を得てからspecへ反映する。対象と振る舞いは肯定形で書く。候補、却下案、非目標は入れない。各振る舞いは1箇所だけで定義する。
- 変更要求は変更後の仕様として本文へ反映し、変更手順や経緯は記載しない。要件を撤回した場合は、その記述と不要になった参照を削除し、『実装しない』『対象外』などの否定要件へ置き換えない。
- 否定要件は、完成状態の振る舞い・安全性・互換性などを定める独立した制約として必要な場合だけ記載する。各記述は『最初からこの完成状態を依頼されていても必要か』で確認し、変更経緯だけを根拠とする記述を除く。
- Markdownで書き、分岐・状態・時系列・順序は、関係を最も直接に表せる視覚構造にする。

## 出力

- 完了報告は作成・更新した正本のパス、`Verify: n/n 合格`、各セルフチェックの観点・判定（合格または適用外）・正本内根拠を含める。未実行の確認を合格と報告しない。
- セルフチェックは、「観測対象」（`../csdd/SKILL.md`）、「requirementsの作成」「specの作成・修正」の各規則と、`../readable-docs/SKILL.md`の「具体性」を個別に確認する。照合は対象に存在する上流に対してだけ行い、存在しない上流との照合は適用外とする。specとrequirementsの両方がある対象は、CSDD適合性レビューのcoverage第1段（`../csdd/SKILL.md`）をセルフチェックでも確認する。
