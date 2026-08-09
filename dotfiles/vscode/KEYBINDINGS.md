# Editor Keybindings

各エディタで共通のKeybindingsを再現するためのBehaviors-Firstなドキュメント

- 修飾キー: `ctrl` = Ctrl / `alt` = Alt (macOS では Option) / `shift` = Shift
- `ctrl+k ctrl+x` のような表記は chord（Ctrl+K を押したあと Ctrl+X）

## エディタ

| Key | 挙動 |
|---|---|
| `ctrl+d` | 行を複製 |
| `ctrl+shift+d` | 行を削除 |
| `ctrl+shift+a` | 選択範囲を構文単位で広げる |
| `ctrl+shift+f` | シンボルをリネーム |
| `ctrl+k ctrl+f` | ドキュメント全体を整形 |
| `ctrl+q` | 行コメントを切替 |
| `ctrl+shift+q` | ブロックコメントを切替 |
| `ctrl+s` | save |
| `ctrl+a` | select all |
| `ctrl+z` | undo |
| `ctrl+shift+z` | redo |
| `ctrl+x` | cut |
| `ctrl+c` | copy |
| `ctrl+v` | paste |
| `ctrl+shift+space` | パラメータヒントや定義プレビューをホバー表示 |
| `tab` | accept suggestion |
| `ctrl+0` | foldingrangeをすべて展開 |
| `ctrl+1` | foldingrangeをレベル1まで折りたたむ |
| `ctrl+2` | foldingrangeをレベル2まで折りたたむ |
| `ctrl+3` | foldingrangeをレベル3まで折りたたむ |
| `ctrl+4` | foldingrangeをレベル4まで折りたたむ |
| `ctrl+5` | foldingrangeをレベル5まで折りたたむ |
| `ctrl+6` | foldingrangeをレベル6まで折りたたむ |
| `ctrl+7` | foldingrangeをレベル7まで折りたたむ |

## 検索

| Key | 挙動 |
|---|---|
| `ctrl+f` | 検索を開く） |
| `ctrl+f` | 次の一致へ |
| `ctrl+shift+f` | 前の一致へ |

## タブ

| Key | 挙動 |
|---|---|
| `ctrl+t` | 無題の新規ファイルを開く |
| `ctrl+shift+t` | open recently closed tab |
| `ctrl+w` | close tab |
| `ctrl+tab` | 次のタブへ |
| `ctrl+shift+tab` | 前のタブへ |

## Markdown（Markdown系のみ）

| Key | 挙動 |
|---|---|
| `alt+1` | 見出しレベルを下げる |
| `alt+2` | 見出しレベルを上げる |
| `alt+b` | 太字を切替 |
| `alt+c` | インラインコードを切替 |
| `alt+i` | イタリックを切替 |
| `alt+d` | タスクリストのチェックを切替 |
| `ctrl+p` | プレビューを開く |

## ファイル・エクスプローラ

| Key | 挙動 |
|---|---|
| `ctrl+n` | 新規ファイルを作る |
| `ctrl+shift+n` | 新規フォルダを作る（エクスプローラ上） |
| `ctrl+shift+o` | フォルダを開く |
| `ctrl+shift+f` | ファイル名を変更（エクスプローラでファイル選択時） |

## その他

| Key | 挙動 |
|---|---|
| `ctrl+g` | コマンドパレットを開く |
| `alt+e` | エディタにフォーカスを戻す |
| `ctrl+shift+s` | open settings |
| `ctrl+k ctrl+e` | エンコーディングを変更 |
| `ctrl+k ctrl+l` | 言語モードを変更 |
| `ctrl+k ctrl+shift+l` | 言語を自動検出 |
| `ctrl+b` | ブックマークを追加/削除 |
| `alt+t` | 新規ターミナルを開く |
| `ctrl+r` | Code Runner で実行 |
| `ctrl+shift+s` | open settings |
