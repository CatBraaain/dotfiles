---
name: drawio
description: draw.io、.drawio、.drawio.svg、PNG、SVG、PDFの図、フローチャート、アーキテクチャ図、ER図、シーケンス図、クラス図、ネットワーク図、モックアップ、ワイヤーフレームを作成・編集・検証・出力するときに使う。
---

# Draw.io

## 永続成果物と対象

Draw.io Desktop CLIはMermaid変換、ELKレイアウト、出力に必要である。`.drawio.svg`は`content`属性にdiagram XMLを埋め込んだSVGである。

`.drawio.svg`だけを永続的な正本とする。`.drawio`と`.mmd`は一時ファイルであり、処理後に削除する。埋め込みdiagram dataを持たない通常のSVG画像は対象外である。

## CLIラダー

最初に成立する段でCLIを決める。

1. 条件: `drawio`がPATHにある、またはWindowsで`where draw.io`が見つかる。
   行動: 見つかったコマンドを使う。
2. 条件: OS既定の実行ファイルがある。
   行動: WSL2は`"/mnt/c/Program Files/draw.io/draw.io.exe"`、macOSは`/Applications/draw.io.app/Contents/MacOS/draw.io`、Windowsは`C:\Program Files\draw.io\draw.io.exe`を使う。WSL2では必要に応じてユーザーごとの`AppData/Local/Programs/draw.io/draw.io.exe`も確認する。
3. 条件: 前段まででCLIが見つからない。
   行動: `.drawio.svg`を生成できないため中止して報告する。`.drawio`やURLを代替の永続成果物として納品しない。

## CLI実行

sandboxエラーで起動しない環境では、すべてのCLI呼び出しに`--no-sandbox`を追加する。

## 詳細参照

URL出力、OS別の開き方、透明背景・倍率・サイズなどの詳細な出力オプションが必要な場合だけ[URL・詳細出力](references/url-output.md)を読む。

## 図の作成と出力

標準的な図はMermaidで簡潔に書き、draw.ioへ自動配置させる。細かな配置・スタイル・固有シェイプが必要な図はXMLで作成する。図形・アイコンには、draw.io標準シェイプや既存アイコンを自作より優先して使う。

1. 標準的な図は`NAME.mmd`へMermaidを書き、`drawio -x -f xml -o NAME.drawio NAME.mmd`で一時`NAME.drawio`へ変換する。Mermaid構文が不明または変換に失敗した場合だけ、[Mermaidリファレンス](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/shared/mermaid-reference.md)を確認する。
2. 細かな配置・スタイル・固有シェイプを要する図は、各ページを`diagram`要素で表す`mxfile` XMLを`NAME.drawio`へ書く。[draw.io XMLリファレンス](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/shared/xml-reference.md)を確認する。
3. `drawio -x -f svg -e -b 10 -o NAME.drawio.svg NAME.drawio`で正本を生成する。
4. ユーザーが明示したときだけ、同じ一時ファイルからPNG、PDF、JPG、URLを派生出力する。PNGとPDFには`-e`を付け、JPGには付けない。URLは[URL・詳細出力](references/url-output.md)の手順を使う。
5. 出力に成功した後、`NAME.mmd`と`NAME.drawio`を削除する。出力またはURLを開けなければ、絶対パスまたはURLを表示する。

形式を指定されなければ、`NAME.drawio.svg`だけを作成する。Mermaidを画像へ直接出力してはならない。必ず`.drawio`へ変換してから出力する。Mermaidを変換済みの図にはELKレイアウトを追加しない。

## ラベルとファイル名

ファイル名は内容を表す。図のラベルはユーザーの言語に合わせる。ファイル名は小文字ハイフン区切りにする。例: `login-flow.drawio.svg`。

## XMLレイアウト

XMLでは座標を手作業で計算するより、用途に合うELKレイアウトを優先する。XMLで作成した図だけ、必要に応じてレイアウトを適用する。

XMLのノード配置には`--layout`を使う。

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
