---
name: oss-mirror
description: >-
  OSS ライブラリの実装・処理を確認するときにこのスキルを利用する。
---

# OSS Mirror

OSS ライブラリの実装・動作を確認するときは、実リポジトリを `~/mirrors`
配下にクローン（既存なら fetch で最新化）し、**ドキュメントもソースも
実ファイルとして**追う。ドキュメントもウェブ（公式ドキュメントサイト・
README サイト等）ではなくクローン先のファイルだけを読む。
web_fetch / web_search は一切使わない。

## なぜ実リポジトリを本地化するか

実装の正体を追うには、定義・呼び出し元・テスト・CHANGELOG だけでなく
ドキュメントも横断して grep/read する必要がある。ウェブ上のドキュメント
サイトは 1 ページ単位でジャンプできず、ソースとの往復もできない。
実リポジトリを手元に置けば docs 含め全体を一意に追え、確実な根拠で
回答できる。

## 1. リポジトリの配置先

URL から決める。ホストで分けることで同名リポジトリの衝突を防ぐ。

```
~/mirrors/<host>/<owner>/<repo>
# 例: ~/mirrors/github.com/tiangolo/fastapi
#     ~/mirrors/gitlab.com/gitlab-org/gitlab
```

## 2. クローン or 最新化

```bash
DEST=~/mirrors/github.com/owner/repo

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --all --prune      # 既存なら最新化
else
  mkdir -p "$(dirname "$DEST")"
  git clone https://github.com/owner/repo.git "$DEST"
fi
```

特定のバージョンを見たい場合は最新化のうえチェックアウトする:

```bash
git -C "$DEST" checkout <tag-or-branch>
```

## 3. ドキュメントの確認

**クローンしたリポジトリ内のドキュメントだけを読む。** 公式ドキュメント
サイト等のウェブは一切使わない。ソースと同じ実ファイルとして扱う。

```
read $DEST/README.md
read $DEST/CHANGELOG.md
ls  $DEST/docs          # docs/, doc/, wiki 等の配置を確認
```

確認ポイント:

- 求めている挙動が既に公式ドキュメント・CHANGELOG に明記されていないか
- 対象バージョンの API・振る舞い
- 既知の制限・非推奨・ breaking change

## 4. ソースコードの確認

grep で入り口を特定し、read で実装を追う。

```bash
rg -n "<function-or-symbol>" "$DEST"
rg -n "class <Name>"        "$DEST/src"
```

- 定義 → 呼び出し元 → テスト を往復して挙動を確定する
- テスト (`test/`, `tests/`, `*_test.*`) は期待される挙動の仕様書として使う
- 型定義 (`.d.ts`, `.pyi`, stubs) も実装の補強情報として読む

## 出力方針

確認したファイルパス・シンボルを行番号付きで明示し、実コードを根拠に
結論を述べる。「たぶん」でなく、実リポジトリの実ファイルを根拠にする。
