---
name: tickets
description: >-
  対処すべきこと（発見した問題・依頼外課題・予定した作業・アイデア）をローカルチケットストア（~/.agents/tickets）配下の markdownファイルで管理する。ticket の起票・一覧・着手・更新・完了・クローズ・取り下げ、blocked の設定・解除、draft の登録・昇格をするときや、「チケットにしといて」「タスク積んどいて」「あとで直すリストに入れて」等の依頼で使う。成果物を伴う作業（コード・ドキュメント・設定の変更、worktree作業など）に着手するときは「ticket」という語が無くても自動で起票し、作業・レビュー・検証中にその場で直さない課題（依頼範囲外のバグ、スペック逸脱、設計・性能懸念など）を見つけたときも記録に使う。GitHub Issues等の外部トラッカーの操作はしない。
---

# Local Tickets

対処すべきことをローカルチケットストア `~/.agents/tickets/` で管理する。

## 最短経路（頻出フロー）

1. 起票: `ticket_create`（status `open`）
2. 着手: user の承認を得て `ticket_set` で `locked` にし、作業を始める
3. 完了: `ticket_edit` で対処記録を本文へ追記し、`ticket_set` で `closed` にする

対処記録はグローバルAGENTS.md の Report Format を流用する（実施要約の本文数行・変更表・検証表・commit参照）。報告見出し（`## <絵文字> <ラベル> — <要約>`）と `worktree:` 行・`ticket:` 行はチャット報告の形式のため含めない。追記を要する遷移（`closed`・`blocked`・`cancelled`）は、追記してから status を変更する。

詳細な規則（遷移・`after`・着手条件・構文・引継ぎ・一覧・fs 直接操作）は後段の各節にある。

## ストア

- 1 ticket = 1 markdownファイル。`~/.agents/tickets/<project>/` に置く。`<project>` は対象リポジトリのルートディレクトリ名（リポジトリ外ならカレントディレクトリ名）
- 対象ストアは、user が対象project（全project横断を含む）を明示しない限り、現在のプロジェクト（セッションcwd のリポジトリ）の 1つに限る。着手対象の選定（「次の ticket」等）もこの範囲から行い、他project の ticket を候補に含めない
- ファイル名は `<YYYYMMDD-HHMMSS>.md`、ID は拡張子を除いた文字列。ticket tool / CLI がローカル時刻から採番する（fs tools 直接起票時の採番は「fs tools 直接操作」に従う）
- `status` と `after` は frontmatter、タイトルは H1（日本語可）、本文は必要な見出しだけの Markdown で管理する。project はディレクトリで表現し、frontmatter には書かない

## いつ使うか

大きく3つ: 成果物を伴う作業の着手前の自動起票、対処すべきことを後回しにする瞬間の記録、明示依頼によるストア操作。

### 着手前に自動起票する

成果物を伴う作業（コード・ドキュメント・設定の変更、ファイル作成・削除、worktree作業など）の着手前に起票する。判断は agent が行い、追加確認はしない。ticket が作業ログの役割を兼ね、完了時の追記は「最短経路（頻出フロー）」の対処記録に従う。

- 編集・write・worktree 作成など、成果物を変更する最初のツール呼び出しより前に `ticket_create` を実行する。実行できない場合は、その理由を報告に明示する
- 対象: 成果物を伴う作業の着手（軽微な修正を含む）。ticket は着手までの間 `open`、作業を始めた時点で `locked`
- 対象外: 読み取り専用の調査・検索・検証、質問・相談への回答
- user の起票指示は「明示依頼で操作する」に従う（調査・レビューなどファイル編集を伴わない対象も起票してよい）
- 作業中に見つけた依頼外課題は「発見時に記録する」に従い、その場で直さない問題だけを起票する

### 発見時に記録する

変更依頼で問題を見つけたときは、依頼達成に必要か、依頼対象の挙動に直接関係するかで扱いを決める。

- 依頼達成に必要、または依頼対象の挙動に直接関係する問題: 明示された変更範囲内ならその場で修正する
- 依頼と無関係に偶然見つけた問題、現在の依頼の目的・契約に影響しない独立した問題: review skill の重要度「中」以上のときだけ別チケットにする。「低」（typo、軽微な lint・format指摘、細かい改善提案など）は起票せず、報告や reviewワークファイルに参考として残す
- user が後回しと判断した問題（「あとで直して」等）、現タスクの外で対処すべき懸念（spec乖離、性能懸念、設計上の疑問）: 関連性にかかわらず別チケットにする
- 関連性や変更範囲の判断が曖昧なら user に確認する。user が対処不要と判断した問題は起票しない
- 起票前に同じ `<project>/` の `open` または `draft` ticket を読み、重複があれば新規に起票せず既存ticket の本文に補足する
- 本文には、後で対処する人が判断できる観測事実（場所・内容・出力）を残す。対処方針が決まっているときは対処内容も「要件」として書く
- 起票・更新した ticket ID は完了報告で列挙する

レビューの扱い:

- レビューのみの依頼: 対象を修正せず指摘を評価・報告する。後続の修正依頼で変更範囲内の指摘を修正する
- 依頼対象外の課題・user が後回しを決めた課題: review skill の重要度で高・中は起票し、低（参考指摘）は起票せず報告や reviewワークファイルに残す
- 変更依頼上の課題: 高（放置すると達成を妨げる）は範囲内なら修正し範囲外なら起票。中（対処する価値がある）は直接関係し範囲内なら修正し無関係なら起票。低は起票しない

### 明示依頼で操作する

「ticket にしといて」「タスク積んどいて」「これクローズして」等の依頼で、起票・一覧・着手・更新・完了・取り下げを行う。問題に限らず、user が予定した作業も対処すべきこととして起票する。起票時は user の指示内容を優先する。

即座に対処しないアイデア・メモの依頼（「アイデアを溜めといて」等）は `status: draft` で起票する。draft は即座に取り掛からない途中段階で、自動起票・発見時の記録では使わない。「あの draft を着手して」等の依頼では `open` へ昇格させてから「状態」の着手フローに従う。

## 状態

使用できるstatusは6種。

- `draft`: アイデア蓄積の途中段階。即座に取り掛からない
- `open`: 未着手
- `blocked`: 外部要因（依存ticket の未完了を含む）の解消待ち。着手しない
- `locked`: 別のセッションが対処を保持（排他）。着手しない
- `closed`: 完了
- `cancelled`: 中止

`after` は、着手前に完了を待つ同一 `<project>/` 内の ticket の ID を frontmatter に単一の文字列で指定する。依存がなければ省略する。存在する未完了の ticket（`closed`・`cancelled` を除く）だけを指定でき、複数依存は不可。status の同時明示が優先される。

遷移のタイミング:

- 起票 → `open`（アイデア蓄積の明示依頼のみ `draft`）
- draft の昇格（明示依頼）→ `open`
- 対処に着手（調査を含む）→ `locked`
- 外部要因の解消待ち → `blocked`（待つ理由と解除条件を本文に）
- 未解決 `after` の指定 → `blocked`（status 未指定時。依存先ID と解除条件を本文に）
- blocked の外部要因が解消 → `open`
- `after` の解除 → `blocked` なら `open`（status 未指定時）
- 依存先の `closed` → 同一project でその ID を `after` に持つ `blocked` ticket は自動で `open`
- 対処が完了し問題が解消 → `closed`（対処記録を本文へ追記）
- 対処しないことに決定（重複、意図した挙動、user判断）→ `cancelled`（理由を本文に）

`open` から `locked` を経由せず直接 `closed` にしてよい（外部要因で解消した場合など）。単純なstatus変更（`draft` から `open` 等）では本文を編集しない。自動解放や、対処を伴わない解消の `closed` には不要な追記をしない。

着手はまずuser の承認を得る。agent が自ら選んだticket では、ticket ID・タイトル・内容の要約・考えている進め方を示して承認を求め、user が特定の ticket を明示した依頼なら依頼自体が承認にあたる。着手できるのは `open` かつ `after` が未設定か依存先が `closed` の ticket のみで、`draft`・`blocked`・`locked` には着手しない（draft は明示依頼で `open` へ昇格後に着手）。承認後は、ファイル編集の開始を待たず調査など対処に向けた作業を始めた時点で `locked` にする（重複着手・バッティングの防止）。コード修正を伴う対処は、worktree規約に従いworktree と branch を作る。`locked` は完了（`closed`）か取り下げ（`cancelled`）で外れ、異常終了などで残れば user の指示で `open` に戻す。

`ticket_set` で依存先を `closed` にすると、同一project内でその ID を `after` に持つ `blocked` ticket は自動で `open` に解放される。手動では解放しない。解放の確認は `ticket_list`（CLI: `ticket list --status blocked,open`）で候補を絞り、`ticket_show`（CLI: `ticket show <id>`）で `after` と status を読む。通常の一覧に `after` は表示されない。

## 操作

Ticket の操作は ticket tools（`ticket_list` / `ticket_show` / `ticket_create` / `ticket_set` / `ticket_edit`）を使う。tool が無いharness では `ticket` CLI のサブコマンド（`list` / `show` / `create` / `set` / `edit`）を bash で実行する。いずれも使えない環境は「fs tools 直接操作」に従う。

- 起票: `ticket_create`（CLI: `ticket create`）。ID は採番されるため、`title`・`body`・`status`・`after` を分けて渡し、`body` には frontmatter と H1 を含めず H1 の直後に置く本文だけを渡す
- status・`after` の変更: `ticket_set`（CLI: `ticket set`）。指定したフィールドだけを frontmatter で更新する。未解決の `after` の設定と解除は、status を明示しなければ status と連動する
- 本文の更新: `ticket_edit`（CLI: `ticket edit`）。先に `ticket_show` で最新の本文を読み、その本文（frontmatter を除きH1 を含む）から一度だけ現れる短い文字列を `old` へ正確にコピーする（一意でなければ周辺文を含める。チャットや別ファイルの文章から `old` を推測しない）。0回または複数回の一致なら失敗する
- 本文追記を要する遷移も `ticket_edit` → `ticket_set` の順（手順は「最短経路（頻出フロー）」に同じ）。原子的にまとめるtool / CLI はなく、片方が失敗したら再実行を重ねず `ticket_show` で現状を確認して対処する
- `after` の不存在・`closed`・`cancelled` 指定や循環は tool・CLI が検証して失敗する。`open` かつ依存未解決は `next` の対象外になるだけで `set` 自体は許される。着手前に `ticket_show` で status と `after` を確認する

## 引継ぎ

委譲・再開の引継ぎでは、対象project・ticket ID を明記し、更新を「保存済み（成功を確認した更新）・未反映（未実行の本文・status・`after` の差分）・結果不明（送信したが成否が分からない更新）」の3つに分けて渡す。結果不明を未保存と決めつけない。再開時は `ticket_show` で現在の本文と、必要なら status・`after` を確認し、残る更新だけを実行する。

## 一覧

Ticket の一覧は `ticket_list` を使う。status絞り込みは `status` 引数、全project横断は `all` 引数で行う。tool が無い環境では CLI（`ticket list --status <s>[,<s>...] [--all]`）を使う。

## fs tools 直接操作（ticket tools・CLI が使えない環境のみ）

ticket tools も `ticket` CLI も使えない環境に限る。現行の pi 環境では ticket tools が常備されているため、通常この節を読む必要がない。tool・CLI が使える環境でストアの mdファイルを直接書き換えない。

- 採番は `date +%Y%m%d-%H%M%S`（ローカル時刻）。同一ID のファイルがあるときは、衝突しなくなるまで +1秒ずらす
- 起票は次のテンプレートから始める

```md
---
status: open
---

# Ticket title

## 背景

（対処の経緯・理由を1〜3行）

## 要件

（対処内容。着手・完了を判断できる形で）
```

本文は必要な箇所だけ編集し、既存の内容を可能な限り維持する。frontmatter も必要に応じて編集してよいが、完全な保護や構造の維持は保証しない。壊れた場合は内容を確認し、修正する。

## 対象外

- GitHub Issues等の外部トラッカーの操作はしない
