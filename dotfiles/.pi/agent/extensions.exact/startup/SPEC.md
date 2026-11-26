# startup拡張機能Spec

pi のセッション開始時に、共通primingスクリプト `~/.agents/cli/startup`（windows は `startup.exe`。振る舞い契約は `dotfiles/.agents/cli.exact/startup/SPEC.md`）を detached実行する。エージェント向けツール、コマンド、UI表示は提供しない。スクリプトの中身（何を primingするか）はこの拡張の関知外であり、スクリプト側の spec が正本である。

## 起動条件

| イベント | `event.reason` | 動作 |
| --- | --- | --- |
| `session_start` | `startup` | `~/.agents/cli/startup`（windows は `startup.exe`）を spawnする |
| `session_start` | `startup` 以外（`new` / `resume` / `fork` / `reload`） | 何もしない |

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
