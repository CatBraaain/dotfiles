---
name: htmlshot
description: HTML/CSS で図・図解・図表・フローチャート・アーキテクチャ図・インフォグラフィック・簡易モックアップなどをデザインし、正本HTML を埋め込んだPNG（.html.png）として生成・配布するときに使う。既存の .html.png を編集・再shotするときにも使う。drawio を明示された場合、.drawioファイルの操作、markdown文書内にソースを埋め込むmermaid記述、通常の画像編集には使わない。
---

# htmlshot

## 永続成果物と対象

`.html.png` はレンダ結果の PNG に iTXtチャンクで埋め込んだ正本HTML を持つ。ビューアと GitHub では普通の PNG として表示され、埋め込み正本から HTML を取り出して編集し、再shotできる。

新規作成と既存の `.html.png` の編集では、その `.html.png` を単一の永続的な正本とする。正本HTML を別ファイルとして保持せず、必要になったときだけ `extract` で取り出す。エージェントが shotのために書いた一時HTML は、shot成功後に削除する。正本は PNG の中にあり、再編集時は extract で取り出して編集し、再shotする。メタデータを持たない通常の PNG、markdown内の mermaid、`.drawio` は対象外である。

## CLI

実行は `~/.agents/cli/htmlshot` で行う。apply が owner実行権を付与する単一実行ファイルであり、依存のインストールも不要である。

```
usage: htmlshot shot <input.html> [-o <output.png>] [--width <n>] [--height <n>] [--scale <n>] [--unsafe]
       htmlshot extract <input.png> [-o <output.html>]
       htmlshot verify <input.png>
```

`shot` だけがヘッドレスChromium でのレンダを行う。`extract` と `verify` はレンダ環境なしで動く。

## 図の作成と出力

1. 正本HTML を書く。CSS は `<style>` で同一ファイルに完結させ、キャンバス寸法は body で固定する
2. `<script>` と外部参照（`http:`・`https:`・`//`・`file:`）は検出されると shotが失敗する。同一入力からの同一レンダを保ち、画像の中に実行コードを持ち込まないためである。画像・フォントは `data:` URL で埋め込む
3. `htmlshot shot NAME.html --width <w> --height <h>` で `NAME.html.png` を生成する。サイズは図に合わせて指定する
4. `htmlshot verify NAME.html.png` でフォーマットとチェックサムを確認する

`--unsafe` は制約検出を無視して続行するオプションであり、使ったときは警告行を確認すること。通常は使わない。

## 編集と再shot

1. `htmlshot extract NAME.html.png` で正本を `NAME.html` に取り出す。checksum検証つきでバイト一致する
2. 取り出したHTML を編集する
3. 同じ `--width`・`--height`・`--scale` で再shotし、既存の `.html.png` を更新する

`checksum mismatch` は PNG が壊れていることを示す。その場合は当該ファイルを正本として扱わず報告する。

## ファイル名

ファイル名は内容を表す小文字ハイフン区切りにする。例: `login-flow.html.png`。

## 詳細参照

フォーマット規約（`htmlshot/v1`、iTXt、checksum）の詳細が必要な場合だけ `~/.agents/cli/htmlshot/SPEC.md` を読む。
