# ADR: pi のサンドボックス方針

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-08-11 |
| **Subject** | pi の bash 実行に対するサンドボックス(書き込み制限 + 確認ゲート) |

---

## ゴール

```
bash を安全に回す  ＋  web_fetch / web_search は自由  ＋  workspace 外への書き込みを制限  ＋  push/publish 等は確認
```

**対象**: 自分のマシン・自分のリポジトリ(信頼できないコードは今は扱わない)

---

## 比較

2 つの独立した決定に分かれる。

**(1) どのサンドボックス手法か** — 欲しいのは「fs 制限あり ＋ network 開放」。**srt だけが network 強制隔離(allow-only・全許可なし)**。他はどれも network 開放可能で、bwrap が軽量・標準・NixOS 標準の点で最も優位。

| 手法 | fs 制限 | network | 重さ | 評価 |
|---|---|---|---|---|
| bwrap | ✓ | 開放(`--unshare-net` 省略) | 軽 | 軽量・標準・NixOS 標準 |
| firejail | ✓ | 開放(デフォルト) | 軽 | 同質・bwrap に勝点なし |
| landlock(LSM) | ✓ | 無干渉(fs のみの概念) | 最軽 | ツール整備が未成熟 |
| container(nspawn/docker) | ✓ | 開放可(`--network=host`) | 重 | 環境分離が過剰 |
| VM | ✓ | 開放可 | 最重 | 別カーネル・大幅過剰 |
| srt | ✓ | **強制隔離(allow-only)** | 中 | network 開放できず |

**(2) 何をフェンスするか** — network 開放な手法なら pi全体でも fetch は死なない。よって評価軸は「列挙の手間」と「信頼境界」。

| 対象 | 列挙する書き込みパス | 信頼境界 | 評価 |
|---|---|---|---|
| pi全体(`bwrap … pi` で起動) | workspace ＋ /tmp ＋ キャッシュ **＋ pi 内部**(`~/.pi`, sessions, 拡張の `node_modules` 等) | pi 自身もフェンス | pi 内部の列挙が増え・変化に追従が必要 |
| bash のみ(拡張が各コマンドを bwrap) | workspace ＋ /tmp ＋ キャッシュ | pi は信頼・bash のみ不信任 | 列挙が最小・信頼境界が明確 |

> 一言: 「srt が network を開放できない」だけの話で、fs 制限＋network 開放なら bwrap に限らずどれでも動く。bwrap は軽量さと標準性で最も優位。pi全体 vs bashのみ は列挙の手間次第。

---

## 脅威モデル

| 脅威 | 内容 | スコープ | 対応 |
|---|---|---|---|
| **A** | agent が意図せず push / publish / 破壊コマンド | **IN** | 確認ゲート(文字列マッチ) |
| **B** | bash の任意コードが秘密を持ち出す / マルウェアDL | **OUT**(YAGNI) | 将来: network フェンス追加 |

脅威B は「信頼できないコードに pi を向ける」時にのみリアルになる。野良リポジトリ・PR の CI 等を扱う段階で network フェンスを足す。

---

## トレードオフ

### ✓ 良い
- fetch が自由
- workspace 外の書き込みを機械的に弾く
- push/publish に承認を挟む
- 設定は bwrap 1枚＋キーワードリスト

### ✗ ギャップ(許容済)
- 確認済み global install の postinstallは network 開放・実質フェンス外で走る
- 文字列マッチは境界ではない(hostile に抜かれる)
- Linux は EPERM で黙って失敗(strace で追う)

---

## 検討から外した案

- **unfenced-on-confirm**(確認で通したコマンドはフェンス回避) → `bun run` の auto-install等、文字列マッチで「フェンス外でよい」を判定するのが不可能。
- **キャッシュを workspace にリダイレクト** → 共有キャッシュの速さ・重複回避を捨てることになるため見送り。中央キャッシュを使い、各PMの中央パスを許可域に列挙する方向。

---

## 実装時にやること(bashのみ ＋ bwrap 採用の場合)

```
1. 書き込みパスは実環境をプローブ（推測しない）
   npm config get cache / bun pm cache / ls ~  → 実在ディレクトリのみ許可域へ

2. NixOS なので /nix の ro-bind が必須
   実行ファイルが /nix/store を指すため、ro で見せないと動かない

3. ゲートのキーワードを確定
   git push / npm publish / gh / rm -rf / sudo / > / tee / global install 系
```

**次**: ロジックを伴うので SDD フローで進める — 短い spec(writable set / ゲートキーワード / bwrap 起動形 / 渡す env)を書き、go/no-go 後に実装。
