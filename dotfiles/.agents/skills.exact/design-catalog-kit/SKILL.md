---
name: design-catalog-kit
description: >-
  HTMLデザイン案を独立した軸ごとのディレクトリに作り、同梱generatorからindex.html viewerを生成して
  ブラウザーで閲覧・比較する。デザイン比較の見せ方の正本であり、ページ・コンポーネント・CSSアニメーションの
  HTML案カタログ、各軸の全案を1行に並べるiframe比較viewer、案ごとのReplayを作成・更新する依頼で使う。
  比較閲覧までを扱い、選択案の採用・記録・統合は行わない。
compatibility: Node.js and a browser. No external runtime dependencies.
---

# Design Catalog Kit

## 軸と案

利用者の対象・目的・制約から、他軸に依存せず比較できる軸を設ける。既存の対象があれば基準案にし、なければ暫定基準案を作る。各軸では比較要素以外を基準案へ揃え、各案の説明に基準から変えた要素と見た目・動作の差を明記する。

案数は利用者の指定に従い、指定がなければ提示する異なる方向性の数に合わせる。差を説明できない重複案で数を埋めない。

案HTMLのデザインには `frontend` と `design-taste-frontend` を適用し、対象と制約に合う見た目を作る。同梱templateはviewerだけに使い、案のデザインを固定しない。

## カタログを作る

作業用の独立した `dist/` をカタログルートにする。既存プロジェクトのビルド出力、特にdotfiles-managerが使うリポジトリ直下の `dist/` とは分ける。

```text
dist/
├── catalog.json
├── index.html                     # generator output
└── designs/
    └── <axis-id>/
        └── <option-id>/
            ├── index.html
            └── assets/            # optional local assets
```

各案は単独で表示・操作できるHTML文書にする。素材はカタログルート内に置き、案から相対参照する。フォーム・メニューなどを実操作できるようにする。hover・scrollが起点の案では、操作手順を案の説明へ書く。CSSアニメーションは、初期ロードまたは説明した操作で開始する。

`catalog.json` は次の形式にする。配列順がviewerの表示順になる。

```json
{
  "schemaVersion": 1,
  "id": "button-motion",
  "title": "Button motion catalog",
  "axes": [
    {
      "id": "entrance",
      "label": "Entrance",
      "description": "Compare how the same button appears.",
      "options": [
        {
          "id": "fade",
          "label": "Fade",
          "description": "Changes opacity only from the static baseline. Starts on load.",
          "path": "designs/entrance/fade/index.html"
        },
        {
          "id": "slide",
          "label": "Slide",
          "description": "Adds upward movement to the same opacity entrance. Starts on load.",
          "path": "designs/entrance/slide/index.html"
        }
      ]
    }
  ]
}
```

- 軸・案は各1件以上。IDは小文字英数字とハイフン。軸IDはカタログ内、案IDは同じ軸内で一意にする。
- カタログID、軸ID、案IDは再生成時にも保持する。別のカタログには別のカタログIDを使う。
- タイトル・ラベル・説明は空でない文字列。案のpathはルートからの相対HTMLファイルパスにする。
- generatorは形式違い、ID重複、欠落HTML、HTML以外、絶対パス・URL・ルート外の実ファイル参照を拒否する。失敗時は既存viewerを変更しない。正常生成でも案HTML・素材は変更しない。

## 生成と閲覧

以下のパスはこのSKILL.mdのディレクトリを基準に絶対パスへ解決して実行する。`CATALOG_ROOT` は作成した独立 `dist/` の絶対パス、`SKILL_DIR` はこのskillの絶対パスに置き換える。

```bash
node "$SKILL_DIR/assets/build-viewer.mjs" "$CATALOG_ROOT"
node "$SKILL_DIR/assets/serve-catalog.mjs" "$CATALOG_ROOT" --port 4173
```

生成成功時は生成先 `index.html`、配信開始時は閲覧URLがstdoutに出る。失敗は非ゼロ終了と理由になる。serverは継続稼働し、終了はCtrl+C。既定portは4173、別portを明示できる。

配信先は `127.0.0.1` に限定する。serverは選択ルート内のファイルを公開するため、専用ルートだけを渡し、公開したくないファイルを混ぜない。生成・配信中に別processで祖先ディレクトリを置換しない。ルート外参照はsymlinkも含め拒否される。

案HTMLとJavaScriptは利用者が信頼するローカル成果物として扱う。iframeはCSSをviewerや他案から分離するが、不信任コードの安全な実行環境ではない。`file://` ではなく、serverが示すローカルHTTP URLで閲覧する。

## 閲覧と比較

- viewerは全軸を軸番号付きのセクションで縦に並べ、各軸の全案を横1行に並べて表示する。表示を選んで切替える操作はなく、各案には並び順の記号 a, b, c… が付く。
- 案行が表示幅に収まらないときは、その軸の行だけが横スクロールする。他の軸のスクロール位置は変わらない。
- 各案の `Replay` はその案のiframeだけを作り直し、案内部の入力・スクロール・JavaScript状態を初期化する。他案は影響を受けず、hover・scrollの操作代行は行わない。
- 選択の伝達は記号で行う。利用者は軸番号と案の記号を組み合わせた「1d」「2a」のような形式で選択を答え、その記号を案IDへ読み替えて扱う。

## 受け渡し前の確認

生成コマンドを実行し、ブラウザーで全案の1行表示・横スクロール・案内部の実操作・各案のReplayを確認する。アニメーション案では経過後にその案のReplayを押し、初期状態から再始動することと、他案が影響を受けないことも観測する。操作起点の案は説明どおり実操作する。Replayのキーボードfocus・実行、案行のArrowLeft / ArrowRight / Home / End、狭い画面のラベル・操作部も確認する。

成果物の絶対パス、閲覧URLと起動コマンド、軸ごとの違い、確認済み項目と未確認事項を渡す。未実測の動作を成功扱いしない。
