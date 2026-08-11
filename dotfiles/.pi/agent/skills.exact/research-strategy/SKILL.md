---
name: research-strategy
description: >-
  調べる目的ごとに手段と web の可否を切り分ける戦略。OSS の実装・挙動は
  ローカルミラーの実ファイルで（web 禁）、公式情報はドキュメントで、
  人々の実感・口コミは reddit・技術記事で。
---

# Research Strategy

目的ごとに手段と web の可否を切り分ける。誤ると、実リポジトリで追うべきものをウェブ検索の「たぶん」で済ませたり、口コミが欲しいものを公式ドキュメントだけで満足したりする。

## 手段の決定木

```mermaid
flowchart TD
  Q{"何を知りたい？"}
  Q -->|"OSS の実装・挙動の正確性"| A["A · ローカルミラーの実ファイル<br/>web 禁"]
  Q -->|"公式の仕様 / 非 OSS"| B["B · 公式ドキュメント<br/>web 可"]
  Q -->|"人々の実感・トラブル"| C["C · reddit · 技術記事<br/>web 可"]
```

| 目的 | 手段 | web | 欲しいもの |
|---|---|---|---|
| OSS の実装・挙動 | ローカルミラーの実ファイル | 禁 | 正確な挙動・根拠 |
| 公式情報（仕様・非OSS） | 公式ドキュメント | 可 | 仕様・API・保証 |
| 人々の実感・トラブル | reddit・技術記事・issue | 可 | 落とし穴・比較・実感 |

---

## A. OSS の実装・挙動を追う（web 禁）

実リポジトリを `~/mirrors` にクローン（既存なら fetch）し、**ドキュメントも
ソースも実ファイルとして**追う。web_fetch / web_search は一切使わない。

**なぜ本地化するか:** 実装の正体を追うには定義・呼び出し元・テスト・CHANGELOG・
ドキュメントを横断して grep/read する必要がある。ウェブのドキュメントサイトは
ページ単位でジャンプできずソースとの往復もできない。手元に置けば docs 含め
全体を一意に追え、確実な根拠で回答できる。

### 作業フロー

```mermaid
flowchart LR
  CL["クローン / 最新化<br/>~/mirrors/host/owner/repo"] --> DOC["ドキュメント<br/>README · CHANGELOG · docs/"]
  DOC --> SRC["ソース<br/>grep → read（定義→呼び出し→テスト）"]
  SRC --> OUT["出力<br/>ファイル:行 で根拠"]
```

### 配置先

URL から決める。ホストで分けることで同名リポジトリの衝突を防ぐ。

```
~/mirrors/<host>/<owner>/<repo>
# 例: ~/mirrors/github.com/tiangolo/fastapi
#     ~/mirrors/gitlab.com/gitlab-org/gitlab
```

### クローン or 最新化

```bash
DEST=~/mirrors/github.com/owner/repo

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --all --prune      # 既存なら最新化
else
  mkdir -p "$(dirname "$DEST")"
  git clone https://github.com/owner/repo.git "$DEST"
fi
```

特定バージョンを見たい場合は最新化のうえチェックアウト:

```bash
git -C "$DEST" checkout <tag-or-branch>
```

### ドキュメント（クローン先の実ファイルのみ、ウェブ不可）

```
read $DEST/README.md
read $DEST/CHANGELOG.md
ls  $DEST/docs          # docs/, doc/, wiki 等の配置を確認
```

確認ポイント:

- 求めている挙動が既にドキュメント・CHANGELOG に明記されていないか
- 対象バージョンの API・振る舞い
- 既知の制限・非推奨・ breaking change

### ソース

grep で入り口を特定し、read で実装を追う。

```bash
rg -n "<function-or-symbol>" "$DEST"
rg -n "class <Name>"        "$DEST/src"
```

- 定義 → 呼び出し元 → テスト を往復して挙動を確定
- テスト（`test/`, `tests/`, `*_test.*`）は期待挙動の仕様書として使う
- 型定義（`.d.ts`, `.pyi`, stubs）も実装の補強情報として読む

---

## B. 公式情報を確認する（web 可）

OSS の実装ではなく仕様・公式の挙動を知りたいとき、クローン対象ではない
（プロプライエタリ・SaaS 等）ものを調べるときは公式ドキュメントを読む。

- 公式ドキュメントサイト・README・リファレンス・仕様書を一次情報に
- web_fetch / web_search を使ってよい（ただし一次ソースに当たる）
- バージョン・公開日を確認し、手元の環境と合致するかを見る

---

## C. 人々の実感・トラブルを調べる（web 可）

公式情報では分からない「実際どうなのか」を知りたいときは、コミュニティの声を
当たる。実装の正確性は出ない代わり、運用上の落とし穴・比較・実感が手に入る。

| 情報源 | 得られるもの |
|---|---|
| reddit（r/&lt;lang&gt;, r/&lt;framework&gt;） | 生の感想・比較・不満 |
| 技術ブログ（Zenn・Qiita・dev.to・Medium） | ハマりどころ・工夫 |
| GitHub Issues / Discussions | 同じ問題に遭った人・公式回答 |
| Stack Overflow | Q&A・解決策 |

読み方:

- 一次情報（A/B）で確定できることは A/B で終わらせ、C は補完用途
- 口コミ単体で結論を出さない。複数ソースの傾向として読む
- 日付・バージョンを確認し、現行バージョンと乖離していないか見る

---

## 出力方針

確認したファイルパス・シンボルを行番号付きで明示し、実コードを根拠に結論を
述べる。「たぶん」でなく、実リポジトリの実ファイルを根拠にする。
