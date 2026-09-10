# pre-chezmoi ローカルフック仕様

## 目的

`dotfiles/` の各フォルダが、フォルダ固有のファイルを生成できるようにする。生成物は既存の `pre-chezmoi.ts` の変換処理を受け、`dist/` に ChezMoi の source として出力される。

本仕様は、既存の `pre-chezmoi.spec.md` に定義された変換へ、ローカルフックの実行段階を追加する。既存仕様の「変換の順序」と「1. dist 再構築」は本仕様の「全体の処理順」に置き換え、「3. dot 変換」へ `.pre-chezmoi.ts` を対象外とする例外を追加する。その他の既存仕様はそのまま適用する。

## ローカルフック

`dotfiles/` 以下に、名前が `.pre-chezmoi.ts` と完全一致する通常ファイルを置くと、ローカルフックとして扱う。

```text
dotfiles/.pi/agent/.pre-chezmoi.ts
```

フック自身は `dist/` へそのままコピーされる。chezmoi は source directory 内の `.` で始まるエントリを、`.chezmoi` で始まるものを除いて無視するため、`dist/` に残ったフックは chezmoi の apply 対象にならない。フックが生成した `.pre-chezmoi.ts` も同様に chezmoi の対象外であり、新しいフックとして実行しない。

## 実行方法

各フックを次のコマンドで、独立した子プロセスとして実行する。

```text
bun <absolute path to hook-file>
```

検出時に source 側フックの絶対パスを確定し、その絶対パスを `bun` へ渡す。

- `cwd`: platform 移動前の、フックを置いたフォルダに対応する `dist/` 内のフォルダ
- 環境変数: 通常の親プロセス環境をそのまま継承する
- 追加の環境変数、専用 API、設定ファイルは提供しない
- フックは `process.cwd()` を生成物の出力先として使う
- フック自身の source ファイルは `import.meta.dir` から参照できる

root のフック `dotfiles/.pre-chezmoi.ts` の `cwd` は `dist/` である。

フックは対応する `dist/` フォルダ以下へファイルを生成する。生成物の名前は既存の人間向け記法を使う。この出力範囲はフック作者が守る契約であり、`pre-chezmoi.ts` はパス検証やサンドボックスを行わない。

```ts
import { writeFile } from "node:fs/promises";

await writeFile("generated.exact/config", "value\n");
```

## 検出と順序

1. `dotfiles/` を再帰的に走査する。
2. `node_modules/` 以下は走査しない。
3. `.pre-chezmoi.ts` と完全一致する通常ファイルを検出する。
4. 検出したフックを、フックの親ディレクトリの相対パスでソートし、一つずつ実行する。比較はパスを `/` で分割した各要素を JavaScript の文字列比較（UTF-16 コード単位の昇順）で行い、片方が他方の接頭辞なら短い方を先にする。
5. 同じフックを一度の実行で複数回起動しない。
6. フックが生成した `.pre-chezmoi.ts` は新しいフックとして検出・実行しない。

この順序により、親フォルダのフックは子フォルダのフックより先に実行される。

## 全体の処理順

`bun pre-chezmoi.ts` は次の順で処理する。

1. `dotfiles/` からローカルフックを検出する
2. `dist/` を削除する
3. `dotfiles/` を `dist/` へコピーする。ただし任意階層の `node_modules/` はコピーしない
4. 検出したローカルフックを順番に実行する
5. platform 別のパス移動を行う
6. dot 変換を行う
7. exact 変換を行う
8. executable 変換を行う
9. merge 変換を行う

ローカルフックは既存の platform・dot・exact・executable・merge 変換より先に実行する。そのため、フックが生成したファイルにも既存変換が適用される。

dot 変換は、名前が `.pre-chezmoi.ts` と完全一致するエントリを対象外とする。これにより `dist/` 内のフックとフック生成物の `.pre-chezmoi.ts` は `dot_` に変換されず、chezmoi の管理対象にならない。

ローカルフックで生成した ChezMoi の `run_before` ファイルは `dist/` に残る。ローカルフックは `run_before` より前に、`pre-chezmoi.ts` の実行中に完了する。

## 成功

すべてのローカルフックと既存変換が成功したとき、生成された `dist/` を出力として終了コード `0` で終了する。

フックがない場合の結果は、ローカルフック機能を追加する前と同じである。

## エラー

次のいずれかが起きたとき、終了コード `0` 以外で終了する。

- フックの起動に失敗した
- フックが終了コード `0` 以外で終了した
- フックがシグナルで終了した
- フックまたは既存変換でエラーが発生した

フックのエラーには、`dotfiles/` からの相対パスを含める。フックの stdout と stderr は親プロセスの同じ出力へ転送する。

エラー発生後は後続のフックと既存変換を実行しない。MVPでは `dist/` の rollback、build 間の lock、staging による原子的な置換は行わない。エラー時の `dist/` は処理途中の状態になり得る。

## 例

入力:

```text
dotfiles/.pi/agent/.pre-chezmoi.ts
dotfiles/.pi/agent/config.exact/placeholder
```

フックが `cwd` に次を生成する:

```text
generated.exact/settings.json
```

既存変換後の出力:

```text
dist/dot_pi/agent/.pre-chezmoi.ts          # そのまま残り、chezmoi の対象外
dist/dot_pi/agent/exact_generated/settings.json
dist/dot_pi/agent/exact_config/placeholder
```

platform 移動の対象フォルダに置いたフックの生成物も、通常の source ファイルと同じように platform 移動の対象になる。

## 受入条件

1. root と任意のネストフォルダの `.pre-chezmoi.ts` を検出する。
2. `node_modules/` 以下のフックを検出・実行しない。
3. フックを親ディレクトリ優先、同じ階層では UTF-16 コード単位順で一度ずつ実行する。
4. フックの `cwd` が対応する `dist/` フォルダになる。
5. フックが生成した raw なファイルへ既存の全変換が適用される。
6. `dist/` に残った `.pre-chezmoi.ts` が dot 変換されず、chezmoi の管理対象にならない。
7. フックの失敗時に後続処理を実行しない。
8. フックがない場合に既存の `pre-chezmoi` の結果が変わらない。
