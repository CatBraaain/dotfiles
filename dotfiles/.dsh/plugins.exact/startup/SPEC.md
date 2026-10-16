# dotfiles-dsh-startup Spec

## 概要

本plugin は、dshプロセスの起動時に共通primingスクリプト `~/.agents/scripts/startup`（振る舞い契約は `dotfiles/.agents/scripts.exact/startup.spec.md`）を detached実行する。tool・UI・設定は一切登録しない。スクリプトの中身（何を primingするか）はこの plugin の関知外であり、スクリプト側の spec が正本である。

## 振る舞い

| 時点 | 振る舞い |
| --- | --- |
| plugin適用時（`apply`、dshプロセス起動時に 1回） | `~/.agents/scripts/startup` を detached spawnする。完了を待たない |
| その以外 | 何もしない |

| 項目 | 値 |
| --- | --- |
| コマンド | `startupScriptPath()` = `~/.agents/scripts/startup`（実行ビット付きで直接実行） |
| 引数 | なし |
| `detached` | `true`（dsh終了後も子プロセスが生きる） |
| `stdio` | `"ignore"` |

spawnした子プロセスは `unref()` し、dsh の終了を妨げない。pi側の `startup` 拡張と同じスクリプトを実行するため二重実行が起きるが、スクリプトの各タスクは自身で冪等性を持つ（`dotfiles/.agents/scripts.exact/startup.spec.md`）。

## 失敗時

- spawn が同期的に throwした場合、または非同期の `error` イベント（スクリプト不在の ENOENT等）が発生した場合は握り潰す。priming の失敗が harness起動に影響しない
- 非同期 `error` は空のリスナーで受ける（リスナー未登録だと uncaught exception で harness が落ちるため）

## 提供するplugin

| 項目 | 値 |
| --- | --- |
| パッケージ / cordis行id | `dotfiles-dsh-startup` / `startup` |
| `export const name` | `"startup"` |
| `export const inject` | なし |
| 登録 | なし（spawn のみ） |
