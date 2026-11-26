# startup拡張機能Spec

pi 起動時の準備を行う実行ファイルを detached で呼ぶ。自動更新と検索サービスの先行起動は [startup CLI の仕様](../../../../.agents/cli.exact/startup/SPEC.md) に従う。

## 起動条件

`session_start.reason` が `startup` で、TUI / RPC モードのときだけ実行ファイルを起動する。

## spawn の条件

| 項目 | 契約 |
| --- | --- |
| コマンド | `startupExecutablePath()` = `~/.agents/cli/startup`（windows は `startup.exe`）。直接実行する |
| 引数 | なし |
| `detached` | `true`（pi終了後も子プロセスが生きる） |
| `stdio` | `"ignore"` |

コマンドはこのスクリプトを単一の実行ファイルにしたもので、`bun` を介さずに起動する。

spawnした子プロセスは `unref()` し、pi の終了を妨げない。

## 失敗時

- spawn が同期的に throwした場合は握り潰す
- スクリプト不在（ENOENT）など非同期の `error` イベントは空のリスナーで握り潰す（リスナー未登録だと uncaught exception で pi が落ちるため）
- どの失敗でもセッションの開始には影響しない
