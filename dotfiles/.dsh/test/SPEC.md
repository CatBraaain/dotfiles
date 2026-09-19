# dsh web smoke test

`test:web` は、dsh web の起動直後に browser で発生する実行時エラーを検出する。

## 振る舞い

| 条件                                                                               | 操作                          | 結果                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| dsh web が起動でき、ページに console error と uncaught page error がない           | `bun run test:web` を実行する | 終了コード 0 で成功し、console error 0 と page error 0 を表示する |
| ページで console error または uncaught page error が発生する                       | `bun run test:web` を実行する | 終了コード 1 で失敗し、検出したエラーを表示する                   |
| dsh web が token URL を出力せず readiness timeout に達する、または起動後に終了する | `bun run test:web` を実行する | 終了コード 1 で失敗する                                           |
| smoke test が正常終了する、失敗する、または SIGINT / SIGTERM を受ける              | test を終了する               | browser session、dsh web、token を含む一時 log が残らない         |
| smoke test を実行する                                                              | test が browser を操作する    | チャット入力、送信、コマンド実行など LLM を呼ぶ操作は発生しない   |

## 静的 fixture のスクリーンショット

| 条件 | 操作 | 結果 |
|---|---|---|
| fixture HTML が生成できる | `bun run render` を実行する | `dist/fixture.html` と `dist/fixture-dark.html` が生成され、12ケースを含む |
| fixture HTML が生成済みである | `bun run shot` を実行する | 全ケースの light/dark、一覧、session-list hover の PNG が `dist/` に生成される |
| fixture HTML を確認したい | `bun serve.ts` を実行する | `http://localhost:4173/` と `/dark` で light/dark の一覧を閲覧できる |

## fake 通信による dsh web 全体スクリーンショット

| 条件 | 操作 | 結果 |
|---|---|---|
| `dsh` と `playwright-cli` が利用できる | `bun run shot:web` を実行する | `?fixture` の fake RPC を使う実 dsh web の light/dark 全体 PNG が `dist/` に生成される |
| `shot:web` が browser を操作する | fake RPC の画面を撮影する | loopback 外の HTTP/WebSocket 通信が発生した場合は終了コード1で失敗する（route 監視は最初の遷移から有効）。transcript が描画されない、または `document.title` に session タイトルが載らない場合も失敗する。loopback control-plane 通信は許可する |
| `shot:web` が正常終了する、失敗する、または SIGINT / SIGTERM を受ける | test を終了する | browser session、dsh web、token を含む一時 log が残らない |
