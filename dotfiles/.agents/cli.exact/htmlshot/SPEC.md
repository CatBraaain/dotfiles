# htmlshot CLI spec

コマンド `htmlshot` の仕様。サブコマンド `shot` / `extract` / `verify` を持ち、HTML正本をメタデータとして埋め込んだ製本PNG の生成・復元・検証をコマンドラインから実行する。実行は `~/.agents/cli/htmlshot` で行い、apply が owner実行権を付与する単一実行ファイルのため依存のインストールも不要である。

読者はこの spec だけを読んで要件の go/no-go をするユーザーと、実装・テストの担当者。

- 用語: 正本は編集対象の HTML。製本は正本をレンダした見た目と正本を埋め込んだPNG。round-trip は 製本 → 抽出 → 編集 → 再製本 の一致を保つこと。
- 方針: 正本の Git での保持は製本のみを想定し、編集前に `extract` で HTML を得る。SVG には対応しない。メッセージツール経由の再エンコードなどでメタデータが失われたPNG の復元は対象外である。

usage:

```
usage: htmlshot shot <input.html> [-o <output.png>] [--width <n>] [--height <n>] [--scale <n>] [--unsafe]
       htmlshot extract <input.png> [-o <output.html>]
       htmlshot verify <input.png>
```

## 製本フォーマット

製本ファイルは拡張子 `.html.png` を推奨する通常の PNG画像であり、一般の画像ビューアと GitHub は通常の PNG として表示する。正本HTML は PNG の `iTXt` チャンク1つに格納する。

| 項目 | 値 |
| --- | --- |
| keyword | `HtmlshotSource` |
| 圧縮 | deflate（compression flag `1`、compression method `0`） |
| language tag / translated keyword | 空文字列 |
| text | 次の JSON（UTF-8）を deflate圧縮したバイト列 |

```json
{
  "format": "htmlshot/v1",
  "checksum": "<html の UTF-8 バイト列の sha256 hex>",
  "render": { "width": 1200, "height": 800, "scale": 1 },
  "html": "<HTML 正本そのもの>"
}
```

- `html` は製本対象HTML のバイト列をそのまま格納する。抽出結果はこのバイト列と一致する（round-trip の一致判定は HTML のバイト一致）。
- `iTXt` チャンクは `IEND` の直前に置く。
- keyword `HtmlshotSource` の chunk が複数ある入力では、`extract` と `verify` は先頭のものを使う。

## shot

`htmlshot shot <input.html>` は正本を読み、制約検査を通した後にレンダし、製本PNG を書き出す。

制約検査:

| 検出対象 | 判定 | 結果 |
| --- | --- | --- |
| `<script>` 要素 | 本文の正規表現走査 | 検出を 1行ずつstderr へ出し、製本せず終了コード非0 |
| 外部リソース参照 | `src`・`href`・`srcset` 属性と CSS の `@import`・`url()` に現れる `http:`・`https:`・プロトコル相対（`//`）・`file:` の参照 | 同上 |

- `data:` URL と相対パス・フラグメント参照は検査対象外である。
- 検出は正規表現による近似検査であり、すべての書き方を検出することは保証しない。
- `--unsafe` を指定したときは検出しても製本を続行し、検出内容を stderr に警告として表示する。製本物のメタデータには制約違反の有無を記録しない。
- 制約検査はレンダの前に行い、検出時は Chromium を起動しない。

レンダ:

| 項目 | 値 |
| --- | --- |
| ブラウザの決定順 | 環境変数 `HTMLSHOT_BROWSER` → `~/.cache/ms-playwright/chromium-*` のうちバージョン番号が最大の配下の `chrome-linux64/chrome`、無いとき `chrome-linux/chrome` → PATH上の `chromium`・`chromium-browser`・`google-chrome-stable`・`google-chrome` の最初に見つけたもの |
| 読み込み | 正本の絶対パスの `file://` URL |
| 起動フラグ | `--headless`、`--screenshot=<一時ファイル>`、`--window-size=<width>,<height>`、`--force-device-scale-factor=<scale>`、`--hide-scrollbars`、`--virtual-time-budget=5000` |
| 既定のレンダ設定 | width 1200、height 800。`--scale` を省略したときの scale は、width が height 以上のとき 1920 ÷ width、それ以外のとき 1080 ÷ height を四捨五入し、1〜3 の範囲に制限した値。`--width`・`--height`・`--scale` で変更する |
| 背景 | Chromium の既定（白）。正本が body等で上書きできる |
| タイムアウト | レンダ開始から 30秒でプロセスを終了し、非0 で終了する |

- レンダで得たPNG の `IEND` 直前に `iTXt` を挿入し、出力先へ書き出す。他の chunk は変更しない。
- 出力先の既定は正本名から拡張子 `.html` を除いた名前に `.html.png` を付けたパス（`a.html` → `a.html.png`）。`-o` で変更できる。既存ファイルの上書きは確認せずに行う。
- 成功時は stdout に `shot: <output> (<width>x<height>@<scale>x, html <bytes> bytes)` と出す。
- ブラウザが決定できないとき、レンダが失敗したとき、出力PNG が妥当な PNG でないときはエラーを stderr へ出し、終了コード非0 で終了する。

## extract

`htmlshot extract <input.png>` は製本PNG から正本を復元する。

1. PNG の chunk を先頭から走査し、keyword `HtmlshotSource` の `iTXt` を探す。無いときは `no htmlshot metadata` を stderr へ出し非0 で終了する。
2. deflate を展開し JSON を解釈する。展開または解釈に失敗したときは非0 で終了する。
3. `format` が `htmlshot/v1` でないときは `unsupported format: <value>` を stderr へ出し非0 で終了する。
4. `html` の UTF-8バイト列の sha256 が `checksum` と一致しないときは `checksum mismatch` を stderr へ出し非0 で終了する。
5. `html` を出力先へ書き出す。出力先の既定は入力名が `.html.png` で終わるときはそれを除いた名前に `.html` を付けたパス、それ以外は最終拡張子を除いた名前に `.html` を付けたパス（`a.html.png` → `a.html`）。`-o` で変更できる。既存ファイルの上書きは確認せずに行う。

成功時は stdout に `extract: <output> (<bytes> bytes)` と出す。

## verify

`htmlshot verify <input.png>` は extract と同じ走査・検証を行い、HTML を書き出さない。

- PNG としてchunk走査が完了しない（`IEND` が無い等）とき、メタデータ `iTXt` の CRC が不一致のときは非0 で終了する。画像部の chunk の CRC は検査しない。
- 成功時は stdout に `verify: <input> ok (<width>x<height>@<scale>x, <pixel width>x<pixel height> px, format htmlshot/v1, html <bytes> bytes)` と出す。`<width>x<height>@<scale>x` はメタデータ `render` の値であり、再製本の `--width`・`--height`・`--scale` にそのまま渡せる。メタデータに `render` が無い製本では、ピクセルサイズをその寸法、`1` を倍率とする。ピクセルサイズは `IHDR` から得る。

## 出力と終了コード

- 成功時の終了コードは 0、失敗時は非0 である。
- 結果の表示は stdout、エラーと警告は stderr へ出す。
- 引数なし、不明なサブコマンド、余分な引数のときは usage を stderr へ出し非0 で終了する。

## 決定性

- 同一の正本・レンダ設定・Chromiumバージョン・フォント環境では、shot は同じピクセルの製本を生成することを意図とする。フォント環境や Chromium のバージョンが異なる再製本ではピクセルが変わることがある。
- round-trip のバイト一致を保証するのは HTML についてのみであり、PNGバイト列全体の一致は保証しない。

## 前提と依存

- npm依存を持たない。PNG chunk操作・CRC32・deflate・sha256 は実装と Bun の標準API（`node:zlib`・`node:crypto`）で賄う。
- `shot` だけが Chromium に依存する。`extract` と `verify` はレンダ環境なしで動く。

## テスト

- テストは `src/*.test.ts` とし、`import { describe, it } from "bun:test"` で書き、assertion は `node:assert/strict` を使う。実行は `cd dotfiles/.agents/cli.exact/htmlshot && bun test` である。
- 対象: 合成PNG への `iTXt` 挿入と抽出のバイト一致、checksum不一致、未対応 `format`、メタデータ不在、制約検出の判定、`--unsafe` 付きの続行、usage と終了コード。
- Chromium を要するshot の E2Eテストは、ブラウザが決定できない環境では skipする。
