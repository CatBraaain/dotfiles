---
name: drawio
description: draw.io 図（.drawio.svg）を作成・編集・検証するときに使う。
---

# Draw.io

`.drawio.svg`（`content` 属性に diagram XML を埋め込んだ SVG）を唯一の正本とする。永続的な `.drawio` を別途作成・管理しない。図の作成・編集・検証は drawio CLI で完結させる。

`drawio` が sandbox エラーで起動しない環境では `--no-sandbox` を付ける。

## 適用条件

- 適用する: `.drawio.svg` の新規作成・編集。
- 適用しない: 埋め込み diagram data を持たない通常の SVG 画像。

## 新規作成

1. mxfile XML を一時ファイル `DIAGRAM.drawio` として書く。ルートは `<mxfile>`、ページごとに `<diagram>` を置く。
2. `drawio -x -f svg -e -o DIAGRAM.drawio.svg DIAGRAM.drawio` で埋め込み付き SVG を生成する。
3. 一時 XML を削除する。

## 編集

1. `drawio -x -f xml -o DIAGRAM.drawio DIAGRAM.drawio.svg` で diagram XML を一時ファイルへ取り出す。
2. `DIAGRAM.drawio` を直接編集する。既存の `mxCell` `id` は再利用しない。
3. `drawio -x -f svg -e -o DIAGRAM.drawio.svg DIAGRAM.drawio` で SVG（描画と埋め込み XML）を再生成する。
4. 一時 XML を削除する。

## シェイプとアイコン

- 図形・アイコンには、適切な既存の draw.io 標準シェイプやアイコンを自作より優先して利用する。
- アイコンには `icons.diagrams.net` から適切なものを探す。
- 必要に応じて `jgraph/drawio-libs` のカスタムライブラリを利用する。
- Templates は図全体の構成やレイアウトの参考として利用する。

## 検証

各 export コマンドは終了コード 0 と `入力 -> 出力` の行を確認する。content 属性を持たない SVG を `-f xml` に渡すと `Error: Export failed` で失敗するため、その場合は処理を中止して報告する。
