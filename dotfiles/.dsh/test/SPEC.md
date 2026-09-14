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
