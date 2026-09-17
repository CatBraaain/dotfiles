# startup 拡張機能 Spec

pi のセッション開始時に、共通 priming スクリプト `~/.agents/scripts/startup`（振る舞い契約は `dotfiles/.agents/scripts/startup.spec.md`）を detached 実行する。エージェント向けツール、コマンド、UI 表示は提供しない。スクリプトの中身（何を priming するか）はこの拡張の関知外であり、スクリプト側の spec が正本である。

## 起動条件

| イベント | `event.reason` | 動作 |
| -------- | -------------- | ---- |
| `session_start` | `startup` | `~/.agents/scripts/startup` を spawn する |
| `session_start` | `startup` 以外（`new` / `resume` / `fork` / `reload`） | 何もしない |

## spawn の条件

| 項目 | 値 |
| ---- | -- |
| コマンド | `startupScriptPath()` = `~/.agents/scripts/startup`（実行ビット付きで直接実行） |
| 引数 | なし |
| `detached` | `true`（pi 終了後も子プロセスが生きる） |
| `stdio` | `"ignore"` |

spawn した子プロセスは `unref()` し、pi の終了を妨げない。

## 失敗時

- spawn が同期的に throw した場合は握り潰す
- スクリプト不在（ENOENT）など非同期の `error` イベントは空のリスナーで握り潰す（リスナー未登録だと uncaught exception で pi が落ちるため）
- どの失敗でもセッションの開始には影響しない
