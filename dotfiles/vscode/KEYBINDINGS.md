# Editor Keybindings

各エディタで共通のKeybindingsを再現するためのBehaviors-Firstなドキュメント

- 修飾キー: `ctrl` = Ctrl / `alt` = Alt (macOS では Option) / `shift` = Shift
- `ctrl+k ctrl+x` のような表記は chord（Ctrl+K を押したあと Ctrl+X）

| Key                   | カテゴリ                 | action                                             |
| --------------------- | ------------------------ | -------------------------------------------------- |
<!-- keep-sorted start by_regex=['`(?:(alt|ctrl)\+)?(?:(shift)\+)?(?<key>[^`]+)`': '${1} ${key} ${2}'] prefix_order=alt,ctrl -->
| `alt+1`               | Markdown                 | 見出しレベルを下げる                               |
| `alt+2`               | Markdown                 | 見出しレベルを上げる                               |
| `alt+e`               | その他                   | エディタにフォーカスを戻す                         |
| `alt+t`               | その他                   | 新規ターミナルを開く                               |
| `ctrl+0`              | エディタ                 | foldingrangeをすべて展開                           |
| `ctrl+1`              | エディタ                 | foldingrangeをレベル1まで折りたたむ                |
| `ctrl+2`              | エディタ                 | foldingrangeをレベル2まで折りたたむ                |
| `ctrl+3`              | エディタ                 | foldingrangeをレベル3まで折りたたむ                |
| `ctrl+4`              | エディタ                 | foldingrangeをレベル4まで折りたたむ                |
| `ctrl+5`              | エディタ                 | foldingrangeをレベル5まで折りたたむ                |
| `ctrl+6`              | エディタ                 | foldingrangeをレベル6まで折りたたむ                |
| `ctrl+7`              | エディタ                 | foldingrangeをレベル7まで折りたたむ                |
| `ctrl+a`              | エディタ                 | select all                                         |
| `ctrl+shift+a`        | エディタ                 | 選択範囲を構文単位で広げる                         |
| `ctrl+b`              | その他                   | ブックマークを追加/削除                            |
| `ctrl+c`              | エディタ                 | copy                                               |
| `ctrl+d`              | エディタ                 | 行を複製                                           |
| `ctrl+shift+d`        | エディタ                 | 行を削除                                           |
| `ctrl+f`              | 検索                     | 検索を開く                                         |
| `ctrl+f`              | 検索                     | 次の一致へ                                         |
| `ctrl+shift+f`        | エディタ                 | シンボルをリネーム                                 |
| `ctrl+shift+f`        | ファイル・エクスプローラ | ファイル名を変更（エクスプローラでファイル選択時） |
| `ctrl+shift+f`        | 検索                     | 前の一致へ                                         |
| `ctrl+g`              | その他                   | コマンドパレットを開く                             |
| `ctrl+k ctrl+e`       | その他                   | エンコーディングを変更                             |
| `ctrl+k ctrl+f`       | エディタ                 | ドキュメント全体を整形                             |
| `ctrl+k ctrl+l`       | その他                   | 言語モードを変更                                   |
| `ctrl+k ctrl+shift+l` | その他                   | 言語を自動検出                                     |
| `ctrl+n`              | ファイル・エクスプローラ | 新規ファイルを作る                                 |
| `ctrl+shift+n`        | ファイル・エクスプローラ | 新規フォルダを作る（エクスプローラ上）             |
| `ctrl+p`              | Markdown                 | プレビューを開く                                   |
| `ctrl+q`              | エディタ                 | 行コメントを切替                                   |
| `ctrl+shift+q`        | エディタ                 | ブロックコメントを切替                             |
| `ctrl+r`              | その他                   | Code Runner で実行                                 |
| `ctrl+s`              | エディタ                 | save                                               |
| `ctrl+shift+s`        | その他                   | open settings                                      |
| `ctrl+shift+space`    | エディタ                 | パラメータヒントや定義プレビューをホバー表示       |
| `ctrl+t`              | タブ                     | 無題の新規ファイルを開く                           |
| `ctrl+shift+t`        | タブ                     | open recently closed tab                           |
| `ctrl+tab`            | タブ                     | 次のタブへ                                         |
| `ctrl+shift+tab`      | タブ                     | 前のタブへ                                         |
| `ctrl+v`              | エディタ                 | paste                                              |
| `ctrl+w`              | タブ                     | close tab                                          |
| `ctrl+x`              | エディタ                 | cut                                                |
| `ctrl+z`              | エディタ                 | undo                                               |
| `ctrl+shift+z`        | エディタ                 | redo                                               |
| `tab`                 | エディタ                 | accept suggestion                                  |
<!-- keep-sorted end -->
