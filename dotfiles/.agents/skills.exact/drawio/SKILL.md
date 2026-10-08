---
name: drawio
description: draw.ioの図（フローチャート、アーキテクチャ図、ER図、シーケンス図、クラス図、ネットワーク図、モックアップ、ワイヤーフレームなど）を作成・編集・検証・出力するときに使う。既存の.drawio、またはdiagram dataを埋め込んだ.drawio.svg・.drawio.pngの編集にも使う。通常のSVG・PNG画像の編集には使わない。
---

# Draw.io

## 永続成果物と対象

Draw.io Desktop CLIはELKレイアウトと出力に必要である。`.drawio.svg`は`content`属性に、`.drawio.png`はPNGに埋め込んだdiagram XMLを持つ。どちらも正本からXMLを取り出して編集し、再生成できる。

新規作成と既存の`.drawio.svg`・`.drawio.png`の編集では、指定された埋め込み形式のファイルを単一の永続的な正本とする。既存の`.drawio`を編集する場合は、そのファイルを単一の正本として保持し、SVG・PNGなどの派生出力は別途明示された場合だけ作る。削除してよい`.drawio`は、作業のためにエージェントが新たに作った一時ファイルだけであり、既存のユーザーファイルは削除しない。埋め込みdiagram dataを持たない通常のSVG・PNG画像は対象外である。

## CLIラダー

目標: 今回必要なレイアウトまたは出力を実行できる draw.io Desktop CLI コマンドを1つ特定する。既存の`.drawio`をCLIなしでXML直接編集する場合は、このラダーを実行しない。

最初に成立する段で止まる。

1. 条件: PATH上の`drawio`（Windowsでは`where draw.io`で見つかる候補）が、今回必要なレイアウトまたはエクスポートを実行できる。
   行動: そのコマンドを使う。名前だけ一致しても機能しなければ次段へ進む。
2. 条件: OS既定の実行ファイルが、今回必要なレイアウトまたはエクスポートを実行できる。
   行動: WSL2は`"/mnt/c/Program Files/draw.io/draw.io.exe"`、macOSは`/Applications/draw.io.app/Contents/MacOS/draw.io`、Windowsは`C:\Program Files\draw.io\draw.io.exe`を使う。WSL2では必要に応じてユーザーごとの`AppData/Local/Programs/draw.io/draw.io.exe`も確認する。候補が機能しなければ次を試す。
3. 条件: 前段までで必要な機能を実行できるCLIがない。
   行動: 必要な成果物を生成できないため中止して報告する。新規作成では`.drawio`やURLを代替の永続成果物として納品しない。

検証: 候補ごとにエージェントが作った一時XMLを使い、今回必要な機能を実行する。失敗した候補は採用せず次段を試す。一時ファイルだけを削除する。

## CLI実行

WSL2 (`uname -r` に `microsoft` を含む) では、すべてのCLI呼び出しに`--no-sandbox`を追加する。付けなければ起動がFATALで失敗する。それ以外の環境では付けない。

`-o`には出力ファイルのパスを渡す。カレントディレクトリ以外へ出力するときは、ディレクトリを含む相対パスまたは絶対パスを指定する。

各CLI出力コマンドで、終了コード0、`入力 -> 出力`の行、出力ファイルの正常性を確認する。

## 詳細参照

URL出力、OS別の開き方、透明背景・倍率・サイズなどの詳細な出力オプションが必要な場合だけ[URL・詳細出力](references/url-output.md)を読む。

## 図の作成と出力

図形・アイコンには、draw.io標準シェイプや既存アイコンを自作より優先して使う。

1. 各ページを`diagram`要素で表す`mxfile` XMLをエージェントが作る一時`TEMP-input.drawio`へ書く。既存ファイルと衝突しないパスを選ぶ。[draw.io XMLリファレンス](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/shared/xml-reference.md)を確認する。
2. 「レイアウト」のELKレイアウトを`--layout`で別の一時`TEMP-layout.drawio`へ適用する。座標を手作業で計算しない。
3. `drawio -x -f svg -e -b 10 -o NAME.drawio.svg TEMP-layout.drawio`で正本を生成する。PNGを指定されたときは`drawio -x -f png -e -b 10 -o NAME.drawio.png TEMP-layout.drawio`で正本を生成する。
4. 正本と別の形式をユーザーが明示したときだけ、同じ一時`TEMP-layout.drawio`からSVG、PNG、PDF、JPG、URLを派生出力する。PNG・SVG・PDFには`-e`を付け、JPGには付けない。URLは[URL・詳細出力](references/url-output.md)の手順を使う。
5. 出力に成功した後、エージェントが作った2つの一時ファイルだけを削除する。出力またはURLを開けなければ、絶対パスまたはURLを表示する。

形式を指定されなければ、`NAME.drawio.svg`だけを作成する。Mermaidからdraw.ioへの変換と、チャット本文のMermaidコードブロックは対象外である。

## ラベルとファイル名

ファイル名は内容を表す。図のラベルはユーザーの言語に合わせる。ファイル名は小文字ハイフン区切りにする。例: `login-flow.drawio.svg`。

## レイアウト

ノード配置には`--layout`を使う。

| 名前 | 用途 |
| --- | --- |
| `verticalFlow` / `horizontalFlow` | フローチャート、パイプライン |
| `verticalTree` / `horizontalTree` | 階層、組織図 |
| `radialTree` | 放射状の木構造 |
| `organic` | ネットワーク、マインドマップ状の図 |

レイアウトの入力と出力には異なる一時パスを使う。

```bash
drawio -x -f xml --layout verticalFlow -o TEMP-layout.drawio TEMP-input.drawio
```

細かな制御には`elkLayered`などのELK設定を含むJSON配列を`--layout`へ渡す。配置済みのXML図でエッジだけを直交ルーティングする場合は`--layout libavoid`を使う。flow/treeレイアウトの後には使わない。

## 編集と検証

1. 既存の`.drawio`を指定されたときは、そのファイルを単一の正本として保持する。レイアウトを適用しない場合はそのXMLを直接編集する。レイアウトを適用する場合は、正本から別の一時入力を作り、さらに異なる一時出力へレイアウトする。出力を検証してから既存ファイルを更新し、失敗時は既存ファイルを変更しない。
2. 既存の`.drawio.svg`・`.drawio.png`を指定されたときは、`drawio -x -f xml -o NAME.drawio NAME.drawio.svg`（PNG正本なら入力を`NAME.drawio.png`にする）で一時`NAME.drawio`へXMLを取り出す。既存の`.drawio`が同名なら、衝突しない別の一時パスを指定する。diagram dataがなくXMLを取り出せないときは中止して報告する。
3. 抽出したXMLを直接編集する。既存の`mxCell`の`id`は再利用しない。レイアウトを適用する場合は異なる一時出力を作り、そのファイルを入力にして指定された埋め込み形式の正本を再生成する。レイアウトを適用しない場合は抽出した一時XMLを入力にする。成功後はエージェントが作った一時ファイルだけを削除する。

XMLにはコメントを一切含めない。属性値の特殊文字はエスケープし、すべての`mxCell`に一意な`id`を使う。グラフモデルには`id="0"`と`id="1"`のルートセルを置く。エッジには`<mxGeometry relative="1" as="geometry" />`を子要素として置く。

出力が空または壊れる場合は、XMLコメント、特殊文字のエスケープ、ルートセル、エッジの`mxGeometry`を確認する。
