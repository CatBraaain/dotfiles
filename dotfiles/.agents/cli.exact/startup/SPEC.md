# startup Spec

`~/.agents/cli/startup`（windows は `startup.exe`）は、pi 起動時に1回実行される primingスクリプトである。detached で実行され、二重実行がありうるため、**個々のタスクは二重実行に耐えること**を契約とする。この spec はスクリプトが現在担当するタスクの契約であり、タスクの追加・削除はこの spec とスクリプトの同時更新を要求する。実行の前提と、タスクごとの health check・起動コマンド・ロック・二重実行への耐性をこの spec が固定し、それ以外の実現方法は実装に委ねる。

## 実行の前提

| 項目 | 契約 |
| --- | --- |
| 呼び出し元 | pi拡張 `startup`（detached で呼ぶ。OS を問わず直接実行する）。Windows の pi update では、スクリプト自身も `update` 引数付きで自身を detached に再実行する |
| 複数回実行 | 許容する。各タスクが自身で冪等性を持つ |
| 完了待ち | `update` 引数なしの実行ではしない。スクリプトは全タスクを fire-and-forget で起動して即座に終了する。`update` 引数付きの実行は「pi update」の表にある windows の場合に限る。この実行は pi update だけを行い、`pi update --all` の終了を待つ |
| 失敗 | スクリプトの失敗が呼び出し元（harness の起動）に影響しない |
| 終了コード | 常に 0 |

## タスク

| タスク | health check | 起動コマンド | 二重実行への耐性 |
| --- | --- | --- | --- |
| pi update | なし | 環境ごとに異なる（「pi update」の表） | ロック取得失敗時はスキップ。取得したロックは更新プロセスの終了まで保持する |
| camoufox server | `${CAMOUFOX_BASE_URL:-ws://127.0.0.1:9378/camoufox}` の authority に対するTCP接続 | `~/.agents/cli/browse server start`（detached。windows は `~/.agents/cli/browse.exe`） | `browse server start` が冪等（起動済みなら no-op、未起動なら server を起動してready を待つ） |
| openserp | `GET ${OPENSERP_BASE_URL:-http://127.0.0.1:7000}/ready` が 2xx | `openserp serve -a <host> -p <port> --quiet` | ポート衝突で 2個目は終了（無害） |

- camoufox server は health check が失敗したときだけ起動する。server は `browse` CLI に内蔵され、`browse server start` が Linux の Xvfb / x11vnc の維持を行い、出力は `<XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log` へ追記する
- pi update はスクリプトの起動ごとに実行対象となる。`pi` が PATH に無い場合はスキップする。`--all` により pi本体とパッケージの両方を更新対象にする
- `~/.agents/cli/browse`（windows は `browse.exe`）が存在しない、`openserp` が PATH に無い場合は、そのタスクを黙ってスキップする
- openserp の host / port は接続先URL の authority から取る（pi の web-search拡張と同じ解決）

### pi update

| 環境 | 起動コマンド（detached） | ロック |
| --- | --- | --- |
| Windows | `~/.agents/cli/startup.exe update` | 再実行されたプロセスが名前付きパイプ `\\.\pipe\pi-update` をロックとして取得できたときだけ `pi update --all` を実行し、終了を待つ。ロックはそのプロセスの終了とともに OS が解放する |
| Windows 以外で `flock` が PATH にある | `flock -n <ロックファイル> pi update --all` | flock が更新プロセスの終了まで保持する |
| Windows 以外で `flock` が PATH に無い | 起動しない | なし |

## スコープ外

- ツール実行時のサーバー起動待ちとタイムアウトは pi の web-search拡張の受け持ち（このスクリプトは起動待ちをしない）
- タスクの成功・失敗の通知、ログの集約
