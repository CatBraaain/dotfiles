---
name: drawio
description: draw.io、.drawio、.drawio.svg、PNG、SVG、PDFの図、フローチャート、アーキテクチャ図、ER図、シーケンス図、クラス図、ネットワーク図、モックアップ、ワイヤーフレームを作成・編集・検証・出力するときに使う。
---

# Draw.io

## 永続成果物と対象

Draw.io Desktop CLIはELKレイアウトと出力に必要である。`.drawio.svg`は`content`属性にdiagram XMLを埋め込んだSVGである。

`.drawio.svg`だけを永続的な正本とする。`.drawio`は一時ファイルであり、処理後に削除する。埋め込みdiagram dataを持たない通常のSVG画像は対象外である。

## CLIラダー

目標: 利用できる draw.io Desktop CLI コマンドを1つ特定する。

最初に成立する段で止まる。

1. 条件: `drawio`がPATHにある、またはWindowsで`where draw.io`が見つかる。
   行動: 見つかったコマンドを使う。
2. 条件: OS既定の実行ファイルがある。
   行動: WSL2は`"/mnt/c/Program Files/draw.io/draw.io.exe"`、macOSは`/Applications/draw.io.app/Contents/MacOS/draw.io`、Windowsは`C:\Program Files\draw.io\draw.io.exe`を使う。WSL2では必要に応じてユーザーごとの`AppData/Local/Programs/draw.io/draw.io.exe`も確認する。
3. 条件: 前段まででCLIが見つからない。
   行動: `.drawio.svg`を生成できないため中止して報告する。`.drawio`やURLを代替の永続成果物として納品しない。

## CLI実行

WSL2 (`uname -r` に `microsoft` を含む) では、すべてのCLI呼び出しに`--no-sandbox`を追加する。付けなければ起動がFATALで失敗する。それ以外の環境では付けない。

`-o`には出力ファイルのパスを渡す。カレントディレクトリ以外へ出力するときは、ディレクトリを含む相対パスまたは絶対パスを指定する。

## 詳細参照

URL出力、OS別の開き方、透明背景・倍率・サイズなどの詳細な出力オプションが必要な場合だけ[URL・詳細出力](references/url-output.md)を読む。

## 図の作成と出力

図形・アイコンには、draw.io標準シェイプや既存アイコンを自作より優先して使う。

1. 各ページを`diagram`要素で表す`mxfile` XMLを`NAME.drawio`へ書く。[draw.io XMLリファレンス](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/shared/xml-reference.md)を確認する。
2. 「レイアウト」のELKレイアウトを`--layout`で適用する。座標を手作業で計算しない。
3. `drawio -x -f svg -e -b 10 -o NAME.drawio.svg NAME.drawio`で正本を生成する。
4. ユーザーが明示したときだけ、同じ一時ファイルからPNG、PDF、JPG、URLを派生出力する。PNGとPDFには`-e`を付け、JPGには付けない。URLは[URL・詳細出力](references/url-output.md)の手順を使う。
5. 出力に成功した後、`NAME.drawio`を削除する。出力またはURLを開けなければ、絶対パスまたはURLを表示する。

形式を指定されなければ、`NAME.drawio.svg`だけを作成する。Mermaidからdraw.ioへの変換と、チャット本文のMermaidコードブロックは対象外である。

## ラベルとファイル名

ファイル名は内容を表す。図のラベルはユーザーの言語に合わせる。ファイル名は小文字ハイフン区切りにする。例: `login-flow.drawio.svg`。

## レイアウト

座標を手作業で計算するより、用途に合うELKレイアウトを優先する。ノード配置には`--layout`を使う。

| 名前 | 用途 |
|---|---|
| `verticalFlow` / `horizontalFlow` | フローチャート、パイプライン |
| `verticalTree` / `horizontalTree` | 階層、組織図 |
| `radialTree` | 放射状の木構造 |
| `organic` | ネットワーク、マインドマップ状の図 |

```bash
drawio -x -f xml --layout verticalFlow -o NAME.drawio NAME.drawio
```

細かな制御には`elkLayered`などのELK設定を含むJSON配列を`--layout`へ渡す。配置済みのXML図でエッジだけを直交ルーティングする場合は`--layout libavoid`を使う。flow/treeレイアウトの後には使わない。

## 編集と検証

1. `NAME.drawio.svg`の`content`属性を確認する。なければ中止して報告する。
2. `drawio -x -f xml -o NAME.drawio NAME.drawio.svg`でXMLを取り出す。
3. XMLを直接編集する。既存の`mxCell`の`id`は再利用しない。
4. 作成時と同じSVG出力コマンドで正本を再生成し、一時`NAME.drawio`を削除する。

XMLにはコメントを一切含めない。属性値の特殊文字はエスケープし、すべての`mxCell`に一意な`id`を使う。グラフモデルには`id="0"`と`id="1"`のルートセルを置く。エッジには`<mxGeometry relative="1" as="geometry" />`を子要素として置く。

各CLI出力コマンドで、終了コード0と`入力 -> 出力`の行を確認する。出力が空または壊れる場合は、XMLコメント、特殊文字のエスケープ、ルートセル、エッジの`mxGeometry`を確認する。
